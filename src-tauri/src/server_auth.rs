//! Instance authentication, independent of workspace caches and of the host UI.
//! Local administration and HTTP use the same transactions. Only opaque random
//! session tokens leave this boundary; the database stores their SHA-256 digest.
use crate::native_files::{err, hash};
use argon2::{
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
use rand_core::{OsRng, RngCore};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    time::Duration,
};
use zeroize::Zeroizing;

type Result<T> = std::result::Result<T, String>;
pub const LIFETIME: i64 = 12 * 60 * 60;
const IDLE: i64 = 30 * 60;
const DAMAGED: &str = "Authentication store is incomplete or damaged. Restore its backup; credentials were not regenerated.";

#[derive(Clone)]
pub struct Auth {
    dir: PathBuf,
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
pub struct Turnstile {
    pub enabled: bool,
    pub site_key: String,
    pub hostname: String,
    #[serde(skip_serializing)]
    pub secret: String,
}
impl Turnstile {
    pub fn action(&self) -> &'static str {
        // Cloudflare's documented dummy responses use action "test".
        if matches!(
            self.secret.as_str(),
            "1x0000000000000000000000000000000AA"
                | "2x0000000000000000000000000000000AA"
                | "3x0000000000000000000000000000000AA"
        ) {
            "test"
        } else {
            "login"
        }
    }
    pub fn validate(&self) -> Result<()> {
        if self.site_key.len() > 256 || self.secret.len() > 256 || self.hostname.len() > 253 {
            return Err("Turnstile configuration is too long.".into());
        }
        if self.enabled
            && (self.site_key.is_empty()
                || self.secret.is_empty()
                || self.hostname.is_empty()
                || self.hostname.contains(['/', ':', ' ', '\\'])
                || !self.hostname.is_ascii())
        {
            return Err("Turnstile requires a site key, secret key and expected hostname (without a scheme or port).".into());
        }
        Ok(())
    }
}
#[derive(Clone)]
pub struct Principal {
    pub id: String,
    pub csrf: String,
    pub must_change: bool,
    pub token_hash: String,
    pub generation: i64,
}
pub struct Login {
    pub token: String,
    pub principal: Principal,
}
fn now() -> i64 {
    chrono::Utc::now().timestamp()
}
pub fn random() -> String {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
fn password_hash(password: &str) -> Result<String> {
    if password.len() < 12 || password.len() > 1024 {
        return Err("Use a password of 12–1024 bytes.".into());
    }
    Argon2::default()
        .hash_password(password.as_bytes(), &SaltString::generate(&mut OsRng))
        .map(|h| h.to_string())
        .map_err(|_| "Password hashing failed.".into())
}
fn username(value: &str) -> Result<()> {
    if value.trim() != value
        || value.is_empty()
        || value.len() > 128
        || value.chars().any(char::is_control)
    {
        return Err(
            "Use a username of 1–128 bytes without surrounding spaces or control characters."
                .into(),
        );
    }
    Ok(())
}
fn verify(password: &str, stored: &str) -> bool {
    password.len() <= 1024
        && PasswordHash::new(stored).is_ok_and(|h| {
            Argon2::default()
                .verify_password(password.as_bytes(), &h)
                .is_ok()
        })
}

// Secrets, SQLite journals and bootstrap files inherit the private directory ACL.
// Fail rather than writing a secret if the host cannot establish it.
fn private_dir(path: &Path) -> Result<()> {
    if let Ok(metadata) = fs::symlink_metadata(path) {
        if metadata.file_type().is_symlink() {
            return Err("Authentication directory cannot be a symbolic link.".into());
        }
    }
    fs::create_dir_all(path).map_err(err)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(err)?;
    }
    #[cfg(windows)]
    private_acl(path)?;
    Ok(())
}
fn create_private(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path).map_err(err)?;
    file.write_all(bytes).map_err(err)?;
    file.sync_all().map_err(err)?;
    #[cfg(unix)]
    fs::File::open(path.parent().ok_or("Missing authentication directory")?)
        .and_then(|dir| dir.sync_all())
        .map_err(err)?;
    Ok(())
}
#[cfg(windows)]
fn private_acl(path: &Path) -> Result<()> {
    use std::{ffi::c_void, os::windows::ffi::OsStrExt, ptr};
    use windows_sys::Win32::{
        Foundation::{CloseHandle, LocalFree, HANDLE},
        Security::{
            Authorization::{
                ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
            },
            GetTokenInformation, SetFileSecurityW, TokenUser, DACL_SECURITY_INFORMATION,
            PROTECTED_DACL_SECURITY_INFORMATION, TOKEN_QUERY, TOKEN_USER,
        },
        System::Threading::{GetCurrentProcess, OpenProcessToken},
    };
    struct Token(HANDLE);
    impl Drop for Token {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
    struct Local(*mut c_void);
    impl Drop for Local {
        fn drop(&mut self) {
            unsafe {
                LocalFree(self.0);
            }
        }
    }
    let failure = || "Could not establish private authentication permissions.".to_owned();
    // Windows supplies the current process identity; environment usernames are
    // unsuitable for service accounts, restricted tokens and automated tests.
    unsafe {
        let mut token = ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return Err(failure());
        }
        let token = Token(token);
        let mut length = 0;
        GetTokenInformation(token.0, TokenUser, ptr::null_mut(), 0, &mut length);
        if length == 0 {
            return Err(failure());
        }
        let mut buffer = vec![0usize; (length as usize).div_ceil(std::mem::size_of::<usize>())];
        if GetTokenInformation(
            token.0,
            TokenUser,
            buffer.as_mut_ptr().cast(),
            length,
            &mut length,
        ) == 0
        {
            return Err(failure());
        }
        let user = &*buffer.as_ptr().cast::<TOKEN_USER>();
        let mut sid = ptr::null_mut();
        if ConvertSidToStringSidW(user.User.Sid, &mut sid) == 0 {
            return Err(failure());
        }
        let _sid = Local(sid.cast());
        let mut n = 0;
        while *sid.add(n) != 0 {
            n += 1;
        }
        let sid = String::from_utf16(std::slice::from_raw_parts(sid, n)).map_err(|_| failure())?;
        let sddl: Vec<u16> = format!("D:P(A;OICI;FA;;;{sid})")
            .encode_utf16()
            .chain(Some(0))
            .collect();
        let mut descriptor = ptr::null_mut();
        if ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            1,
            &mut descriptor,
            ptr::null_mut(),
        ) == 0
        {
            return Err(failure());
        }
        let _descriptor = Local(descriptor);
        let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        if SetFileSecurityW(
            wide.as_ptr(),
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            descriptor,
        ) == 0
        {
            return Err(failure());
        }
    }
    Ok(())
}
impl Auth {
    pub fn open(data: &Path) -> Result<Self> {
        let dir = data.join("auth");
        // Reassert permissions after backup restore or data relocation using
        // only OS APIs; this does not invoke platform tools.
        private_dir(&dir)?;
        if fs::symlink_metadata(&dir)
            .map_err(err)?
            .file_type()
            .is_symlink()
        {
            return Err(DAMAGED.into());
        }
        let auth = Self { dir };
        if auth.dir.join("auth.sqlite").exists() || auth.marker().exists() {
            auth.connection()?;
        }
        Ok(auth)
    }
    fn marker(&self) -> PathBuf {
        self.dir
            .parent()
            .expect("authentication parent")
            .join("auth.initialized")
    }
    fn connection(&self) -> Result<Connection> {
        let path = self.dir.join("auth.sqlite");
        let c = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE)
            .map_err(|_| DAMAGED.to_string())?;
        c.busy_timeout(Duration::from_secs(5)).map_err(err)?;
        let valid = c
            .query_row("SELECT version FROM metadata WHERE id=1", [], |r| {
                r.get::<_, i64>(0)
            })
            .map_err(|_| DAMAGED.to_string())?;
        if valid != 1 {
            return Err(DAMAGED.into());
        }
        let count: i64 = c
            .query_row("SELECT count(*) FROM users WHERE role='admin'", [], |r| {
                r.get(0)
            })
            .map_err(|_| DAMAGED.to_string())?;
        let stored: String = c
            .query_row("SELECT password FROM users WHERE role='admin'", [], |r| {
                r.get(0)
            })
            .map_err(|_| DAMAGED.to_string())?;
        if count != 1 || !stored.starts_with("$argon2id$") || PasswordHash::new(&stored).is_err() {
            return Err(DAMAGED.into());
        }
        Ok(c)
    }
    pub fn status(&self) -> Result<Value> {
        if !self.dir.join("auth.sqlite").exists() && !self.marker().exists() {
            return Ok(
                json!({"configured":false,"username":"admin","turnstile":Turnstile::default(),"secretConfigured":false}),
            );
        }
        let c = self.connection()?;
        let (id, name, must): (String, String, bool) = c
            .query_row(
                "SELECT id,username,must_change FROM users WHERE role='admin'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .map_err(err)?;
        let t = self.turnstile()?;
        Ok(
            json!({"configured":true,"id":id,"username":name,"mustChange":must,"turnstile":t,"secretConfigured":!t.secret.is_empty()}),
        )
    }
    /// Creates the single administrator once. Returns false when another
    /// process or request created it first; the existing identity is kept.
    pub fn initialize(&self, name: &str, password: &str) -> Result<bool> {
        username(name)?;
        private_dir(&self.dir)?;
        // A process lock serializes the existence check and initialization intent.
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(self.dir.join("init.lock"))
            .map_err(err)?;
        fs2::FileExt::lock_exclusive(&lock).map_err(err)?;
        if self.dir.join("auth.sqlite").exists() || self.marker().exists() {
            self.connection()?;
            return Ok(false);
        }
        let hashed = password_hash(password)?;
        create_private(&self.marker(), b"Weave authentication v1\n")?;
        create_private(&self.dir.join("auth.sqlite"), b"")?;
        let mut c = Connection::open(self.dir.join("auth.sqlite")).map_err(err)?;
        c.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;")
            .map_err(err)?;
        let tx = c
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(err)?;
        tx.execute_batch("CREATE TABLE metadata(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL);
            CREATE TABLE users(id TEXT PRIMARY KEY,username TEXT UNIQUE NOT NULL,password TEXT NOT NULL,role TEXT NOT NULL,generation INTEGER NOT NULL,must_change INTEGER NOT NULL);
            CREATE TABLE sessions(token TEXT PRIMARY KEY,user_id TEXT NOT NULL,generation INTEGER NOT NULL,csrf TEXT NOT NULL,expires INTEGER NOT NULL,last_seen INTEGER NOT NULL);
            CREATE INDEX session_expiry ON sessions(expires);
            CREATE TABLE configuration(id INTEGER PRIMARY KEY CHECK(id=1),enabled INTEGER NOT NULL,site_key TEXT NOT NULL,secret TEXT NOT NULL,hostname TEXT NOT NULL);
            CREATE TABLE attempts(id TEXT PRIMARY KEY,window INTEGER NOT NULL,count INTEGER NOT NULL);
            INSERT INTO metadata VALUES(1,1); INSERT INTO configuration VALUES(1,0,'','','');").map_err(err)?;
        tx.execute(
            "INSERT INTO users VALUES(?1,?2,?3,'admin',1,0)",
            params![random(), name, hashed],
        )
        .map_err(err)?;
        tx.commit().map_err(err)?;
        Ok(true)
    }
    /// Headless start. `WEAVE_ADMIN_USERNAME` and `WEAVE_ADMIN_PASSWORD` (or
    /// `WEAVE_ADMIN_PASSWORD_FILE`, read first) create the administrator on a
    /// new installation and are ignored afterwards. Without them the first
    /// browser visit creates it (`setup`). No password is ever generated or logged.
    pub fn provision(
        &self,
        name: Option<&str>,
        password: Option<&str>,
        password_file: Option<&Path>,
    ) -> Result<()> {
        if self.status()?["configured"] == true {
            return Ok(());
        }
        let supplied = match password_file {
            Some(path) => Some(read_password(path)?),
            None => password.map(|p| Zeroizing::new(p.to_string())),
        };
        let Some(password) = supplied else {
            println!("No administrator account yet. Open Weave Server in a browser to create one.");
            return Ok(());
        };
        let name = name.filter(|n| !n.is_empty()).unwrap_or("admin");
        if self.initialize(name, &password)? {
            println!("Administrator account {name} created from the environment.");
        }
        Ok(())
    }
    /// First-visit setup over HTTP: only succeeds while no administrator exists.
    pub fn setup(&self, name: &str, password: &str) -> Result<()> {
        if self.status()?["configured"] == true || !self.initialize(name, password)? {
            return Err("This server already has an administrator. Sign in instead.".into());
        }
        Ok(())
    }
    /// Initial credentials written by earlier versions, if still present.
    pub fn bootstrap(&self) -> Result<Zeroizing<String>> {
        if self.status()?["mustChange"] != true {
            return Err("Bootstrap credentials are no longer available.".into());
        }
        fs::read_to_string(self.dir.join("initial-credentials"))
            .map(Zeroizing::new)
            .map_err(|_| "No bootstrap file. Use admin reset-password.".into())
    }
    fn remove_bootstrap(&self) -> Result<()> {
        match fs::remove_file(self.dir.join("initial-credentials")) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(err(e)),
        }
    }
    pub fn configure(
        &self,
        name: &str,
        password: Option<&str>,
        turnstile: Option<Turnstile>,
    ) -> Result<()> {
        username(name)?;
        let configured = self.status()?["configured"] == true;
        let previous_turnstile = if configured {
            self.turnstile()?
        } else {
            Turnstile::default()
        };
        let mut t = turnstile;
        if let Some(t) = &mut t {
            if t.secret.is_empty() {
                t.secret = previous_turnstile.secret.clone();
            }
            t.validate()?;
        }
        let challenge_changed = t.as_ref().is_some_and(|t| {
            t.enabled != previous_turnstile.enabled
                || t.site_key != previous_turnstile.site_key
                || t.secret != previous_turnstile.secret
                || t.hostname != previous_turnstile.hostname
        });
        if !configured {
            self.initialize(
                name,
                password.ok_or("Set an administrator password before starting the server.")?,
            )?;
        }
        let hashed = password.map(password_hash).transpose()?;
        let mut c = self.connection()?;
        let tx = c
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(err)?;
        let previous: String = tx
            .query_row("SELECT username FROM users WHERE role='admin'", [], |r| {
                r.get(0)
            })
            .map_err(err)?;
        if name != previous || hashed.is_some() || challenge_changed {
            tx.execute("UPDATE users SET username=?1,password=COALESCE(?2,password),generation=generation+1,must_change=CASE WHEN ?2 IS NULL THEN must_change ELSE 0 END WHERE role='admin'", params![name,hashed]).map_err(err)?;
            tx.execute("DELETE FROM sessions", []).map_err(err)?;
            tx.execute("DELETE FROM attempts", []).map_err(err)?;
        }
        if let Some(t) = t {
            tx.execute(
                "UPDATE configuration SET enabled=?1,site_key=?2,secret=?3,hostname=?4 WHERE id=1",
                params![t.enabled, t.site_key, t.secret, t.hostname],
            )
            .map_err(err)?;
        }
        tx.commit().map_err(err)?;
        if password.is_some() {
            self.remove_bootstrap()?;
        }
        Ok(())
    }
    pub fn turnstile(&self) -> Result<Turnstile> {
        self.connection()?
            .query_row(
                "SELECT enabled,site_key,secret,hostname FROM configuration WHERE id=1",
                [],
                |r| {
                    Ok(Turnstile {
                        enabled: r.get(0)?,
                        site_key: r.get(1)?,
                        secret: r.get(2)?,
                        hostname: r.get(3)?,
                    })
                },
            )
            .map_err(err)
    }
    pub fn attempt(&self, peer: &str) -> Result<()> {
        let mut c = self.connection()?;
        let tx = c
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(err)?;
        let n = now();
        tx.execute("DELETE FROM attempts WHERE window < ?1", [n - 300])
            .map_err(err)?;
        let mut denied = false;
        for (key, limit) in [("global".to_owned(), 60), (hash(peer), 10)] {
            let count: i64 = tx
                .query_row("SELECT count FROM attempts WHERE id=?1", [&key], |r| {
                    r.get(0)
                })
                .optional()
                .map_err(err)?
                .unwrap_or(0);
            if count >= limit {
                denied = true;
                break; // Never create new peer rows after the global budget is exhausted.
            } else {
                tx.execute("INSERT INTO attempts VALUES(?1,?2,1) ON CONFLICT(id) DO UPDATE SET count=count+1", params![key,n]).map_err(err)?;
            }
        }
        tx.commit().map_err(err)?;
        if denied {
            Err("Too many login attempts. Try again in five minutes.".into())
        } else {
            Ok(())
        }
    }
    pub fn login(&self, name: &str, password: &str, challenge: &str) -> Result<Login> {
        self.login_with_challenge_validator(name, password, challenge, validate_turnstile)
    }
    fn login_with_challenge_validator(
        &self,
        name: &str,
        password: &str,
        challenge: &str,
        validate: impl FnOnce(&Turnstile, &str) -> Result<()>,
    ) -> Result<Login> {
        if name.len() > 128 || password.len() > 1024 {
            return Err("Login failed.".into());
        }
        let mut c = self.connection()?;
        // Read policy and credentials together. A local configuration change
        // during verification must fail the generation check below, rather than
        // applying an old challenge policy to newly read credentials.
        let (id, expected, stored, generation, must, t):
            (String, String, String, i64, bool, Turnstile) = c
            .query_row(
                "SELECT u.id,u.username,u.password,u.generation,u.must_change,c.enabled,c.site_key,c.secret,c.hostname FROM users u JOIN configuration c ON c.id=1 WHERE u.role='admin'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?,
                    Turnstile { enabled:r.get(5)?, site_key:r.get(6)?, secret:r.get(7)?, hostname:r.get(8)? })),
            )
            .map_err(err)?;
        if t.enabled {
            validate(&t, challenge)?;
        }
        let correct = verify(password, &stored);
        if name != expected || !correct {
            return Err("Login failed.".into());
        }
        let token = random();
        let csrf = random();
        let digest = hash(&token);
        let n = now();
        let tx = c
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(err)?;
        tx.execute(
            "DELETE FROM sessions WHERE expires<=?1 OR last_seen<=?2",
            params![n, n - IDLE],
        )
        .map_err(err)?;
        // Bound durable sessions even if many clients sign in successfully.
        tx.execute("DELETE FROM sessions WHERE token IN (SELECT token FROM sessions ORDER BY last_seen DESC LIMIT -1 OFFSET 31)", []).map_err(err)?;
        let inserted = tx.execute("INSERT INTO sessions SELECT ?1,id,generation,?2,?3,?4 FROM users WHERE id=?5 AND generation=?6", params![digest,csrf,n+LIFETIME,n,id,generation]).map_err(err)?;
        if inserted != 1 {
            return Err("Login failed. Credentials changed.".into());
        }
        tx.commit().map_err(err)?;
        Ok(Login {
            token,
            principal: Principal {
                id,
                csrf,
                must_change: must,
                token_hash: digest,
                generation,
            },
        })
    }
    pub fn session(&self, token: &str) -> Result<Option<Principal>> {
        if token.len() != 64 || !token.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Ok(None);
        }
        // A new installation has no sessions; a stale cookie from another
        // server on this host must still reach first-visit setup.
        if !self.dir.join("auth.sqlite").exists() && !self.marker().exists() {
            return Ok(None);
        }
        let c = self.connection()?;
        let n = now();
        let digest = hash(token);
        let result = c.query_row("SELECT u.id,s.csrf,u.must_change,u.generation FROM sessions s JOIN users u ON u.id=s.user_id AND u.generation=s.generation WHERE s.token=?1 AND s.expires>?2 AND s.last_seen>?3", params![digest,n,n-IDLE], |r|Ok(Principal{id:r.get(0)?,csrf:r.get(1)?,must_change:r.get(2)?,generation:r.get(3)?,token_hash:digest.clone()})).optional().map_err(err)?;
        if result.is_some() {
            c.execute(
                "UPDATE sessions SET last_seen=?1 WHERE token=?2 AND last_seen<?3",
                params![n, digest, n - 60],
            )
            .map_err(err)?;
        }
        Ok(result)
    }
    pub fn logout(&self, principal: &Principal) -> Result<()> {
        self.connection()?
            .execute(
                "DELETE FROM sessions WHERE token=?1",
                [&principal.token_hash],
            )
            .map_err(err)?;
        Ok(())
    }
    pub fn change_password(&self, principal: &Principal, old: &str, new: &str) -> Result<()> {
        if old == new {
            return Err("Choose a different password.".into());
        }
        let mut c = self.connection()?;
        let stored: String = c
            .query_row(
                "SELECT password FROM users WHERE id=?1 AND generation=?2",
                params![principal.id, principal.generation],
                |r| r.get(0),
            )
            .map_err(|_| "Session expired.".to_string())?;
        if !verify(old, &stored) {
            return Err("Current password is incorrect.".into());
        }
        let hashed = password_hash(new)?;
        let tx = c
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(err)?;
        let changed = tx.execute("UPDATE users SET password=?1,must_change=0,generation=generation+1 WHERE id=?2 AND generation=?3", params![hashed,principal.id,principal.generation]).map_err(err)?;
        if changed != 1 {
            return Err("Credentials changed. Sign in again.".into());
        }
        tx.execute("DELETE FROM sessions WHERE user_id=?1", [&principal.id])
            .map_err(err)?;
        tx.commit().map_err(err)?;
        self.remove_bootstrap()
    }
}
pub fn read_password(path: &Path) -> Result<Zeroizing<String>> {
    let metadata = fs::metadata(path).map_err(err)?;
    if !metadata.is_file() || metadata.len() > 4096 {
        return Err("Password file must be a regular file of at most 4096 bytes.".into());
    }
    let value = fs::read_to_string(path).map_err(err)?;
    Ok(Zeroizing::new(
        value.trim_end_matches(['\r', '\n']).to_string(),
    ))
}
fn turnstile_response(t: &Turnstile, value: &Value) -> bool {
    value["success"] == true
        && value["hostname"].as_str() == Some(&t.hostname)
        && value["action"] == t.action()
}
fn validate_turnstile(t: &Turnstile, token: &str) -> Result<()> {
    if token.is_empty() || token.len() > 2048 {
        return Err("Login verification failed.".into());
    }
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Login verification unavailable.".to_string())?;
    siteverify(
        t,
        token,
        &client,
        "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    )
}
// The endpoint argument is private and only production's fixed HTTPS URL is
// reachable from configuration. Tests exercise the real HTTP client locally.
fn siteverify(
    t: &Turnstile,
    token: &str,
    client: &reqwest::blocking::Client,
    endpoint: &str,
) -> Result<()> {
    let mut response = client
        .post(endpoint)
        .json(&json!({"secret":t.secret,"response":token}))
        .send()
        .map_err(|_| "Login verification unavailable.".to_string())?;
    if !response.status().is_success() {
        return Err("Login verification unavailable.".into());
    }
    use std::io::Read;
    let mut bytes = Vec::new();
    response
        .by_ref()
        .take(65537)
        .read_to_end(&mut bytes)
        .map_err(|_| "Login verification unavailable.".to_string())?;
    let value: Value =
        serde_json::from_slice(&bytes).map_err(|_| "Login verification failed.".to_string())?;
    if bytes.len() > 65536 || !turnstile_response(t, &value) {
        return Err("Login verification failed.".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn policy_changes_during_login_require_a_fresh_attempt() {
        let temp = tempfile::tempdir().unwrap();
        let auth = Auth::open(temp.path()).unwrap();
        auth.initialize("admin", "long password").unwrap();
        let initial = Turnstile {
            enabled: true,
            site_key: "site".into(),
            secret: "private-key".into(),
            hostname: "example.org".into(),
        };
        auth.configure("admin", None, Some(initial.clone()))
            .unwrap();
        let result =
            auth.login_with_challenge_validator("admin", "long password", "token", |policy, _| {
                assert_eq!(policy.hostname, "example.org");
                auth.configure(
                    "admin",
                    None,
                    Some(Turnstile {
                        hostname: "new.example.org".into(),
                        ..initial
                    }),
                )?;
                Ok(())
            });
        assert!(result.is_err());
        assert_eq!(
            auth.connection()
                .unwrap()
                .query_row("SELECT count(*) FROM sessions", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            0
        );
        auth.configure("admin", None, Some(Turnstile::default()))
            .unwrap();
        assert!(auth.login("admin", "long password", "").is_ok());
    }
    #[test]
    fn siteverify_transport_fails_closed() {
        use std::io::{Read, Write};
        let t = Turnstile {
            enabled: true,
            site_key: "site".into(),
            secret: "private-key".into(),
            hostname: "example.org".into(),
        };
        let client = reqwest::blocking::Client::builder()
            .no_proxy()
            .timeout(Duration::from_millis(150))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        for (status, body, expected) in [
            (
                "200 OK",
                r#"{"success":true,"hostname":"example.org","action":"login"}"#.to_owned(),
                true,
            ),
            (
                "200 OK",
                r#"{"success":false,"error-codes":["timeout-or-duplicate"]}"#.to_owned(),
                false,
            ),
            (
                "200 OK",
                r#"{"success":true,"hostname":"evil.org","action":"login"}"#.to_owned(),
                false,
            ),
            (
                "200 OK",
                r#"{"success":true,"hostname":"example.org","action":"other"}"#.to_owned(),
                false,
            ),
            ("503 Unavailable", "{}".to_owned(), false),
            ("200 OK", "not json".to_owned(), false),
            ("200 OK", " ".repeat(65537), false),
        ] {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap();
            let worker = std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut request = Vec::new();
                let mut buffer = [0u8; 1024];
                loop {
                    let n = stream.read(&mut buffer).unwrap();
                    request.extend_from_slice(&buffer[..n]);
                    if let Some(end) = request.windows(4).position(|w| w == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&request[..end]);
                        let length: usize = headers
                            .lines()
                            .find_map(|line| {
                                line.to_ascii_lowercase()
                                    .strip_prefix("content-length: ")
                                    .map(|v| v.parse().unwrap())
                            })
                            .unwrap();
                        if request.len() >= end + 4 + length {
                            break;
                        }
                    }
                }
                let request = String::from_utf8(request).unwrap();
                assert!(request.contains("private-key"));
                assert!(request.contains("submitted-token"));
                let _=write!(stream,"HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len());
            });
            assert_eq!(
                siteverify(&t, "submitted-token", &client, &format!("http://{address}")).is_ok(),
                expected
            );
            worker.join().unwrap();
        }
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        drop(listener);
        assert!(siteverify(&t, "submitted-token", &client, &format!("http://{address}")).is_err());
        assert!(validate_turnstile(&t, "").is_err());
        assert!(validate_turnstile(&t, &"x".repeat(2049)).is_err());
    }
    #[test]
    fn persistence_revocation_and_setup() {
        let temp = tempfile::tempdir().unwrap();
        let a = Auth::open(temp.path()).unwrap();
        assert!(a.session(&"a".repeat(64)).unwrap().is_none());
        assert!(a.setup("owner", "short").is_err());
        assert_eq!(a.status().unwrap()["configured"], false);
        a.setup("owner", "initial password").unwrap();
        let id = a.status().unwrap()["id"].clone();
        assert!(a.setup("intruder", "other password").is_err());
        assert!(!a.initialize("admin", "other password").unwrap());
        let login = a.login("owner", "initial password", "").unwrap();
        assert!(!login.principal.must_change);
        assert!(a.session(&login.token).unwrap().is_some());
        assert!(a.login("unknown", "initial password", "").is_err());
        assert!(a
            .change_password(&login.principal, "wrong", "updated password")
            .is_err());
        a.change_password(&login.principal, "initial password", "updated password")
            .unwrap();
        assert!(a.session(&login.token).unwrap().is_none());
        let a = Auth::open(temp.path()).unwrap();
        assert_eq!(a.status().unwrap()["id"], id);
        let login = a.login("owner", "updated password", "").unwrap();
        a.configure("renamed", None, None).unwrap();
        assert!(a.session(&login.token).unwrap().is_none());
        assert!(a.login("renamed", "updated password", "").is_ok());
        fs::remove_file(a.dir.join("auth.sqlite")).unwrap();
        assert!(Auth::open(temp.path()).is_err());
    }
    #[test]
    fn environment_provisions_only_new_installations() {
        let temp = tempfile::tempdir().unwrap();
        let a = Auth::open(temp.path()).unwrap();
        a.provision(None, None, None).unwrap();
        assert_eq!(a.status().unwrap()["configured"], false);
        let file = temp.path().join("password");
        fs::write(&file, "file password value\n").unwrap();
        a.provision(Some("ops"), Some("ignored password"), Some(&file))
            .unwrap();
        assert!(a.login("ops", "file password value", "").is_ok());
        a.provision(Some("other"), Some("another password"), None)
            .unwrap();
        assert_eq!(a.status().unwrap()["username"], "ops");
        let b = Auth::open(&temp.path().join("plain")).unwrap();
        b.provision(None, Some("plain password value"), None)
            .unwrap();
        assert!(b.login("admin", "plain password value", "").is_ok());
    }
    #[test]
    fn expiry_damage_rate_limit_and_challenge() {
        let temp = tempfile::tempdir().unwrap();
        let a = Auth::open(temp.path()).unwrap();
        a.initialize("admin", "long password").unwrap();
        let login = a.login("admin", "long password", "").unwrap();
        a.connection()
            .unwrap()
            .execute("UPDATE sessions SET expires=0", [])
            .unwrap();
        assert!(a.session(&login.token).unwrap().is_none());
        for _ in 0..10 {
            a.attempt("127.0.0.1").unwrap();
        }
        assert!(a.attempt("127.0.0.1").is_err());
        let t = Turnstile {
            enabled: true,
            site_key: "site".into(),
            secret: "secret".into(),
            hostname: "example.org".into(),
        };
        assert!(turnstile_response(
            &t,
            &json!({"success":true,"hostname":"example.org","action":"login"})
        ));
        for v in [
            json!({"success":false,"hostname":"example.org","action":"login"}),
            json!({"success":true,"hostname":"evil.org","action":"login"}),
            json!({"success":true,"hostname":"example.org","action":"other"}),
            json!({"success":true}),
        ] {
            assert!(!turnstile_response(&t, &v));
        }
        let dummy = Turnstile {
            enabled: true,
            site_key: "1x00000000000000000000AA".into(),
            secret: "1x0000000000000000000000000000000AA".into(),
            hostname: "localhost".into(),
        };
        assert!(turnstile_response(
            &dummy,
            &json!({"success":true,"hostname":"localhost","action":"test"})
        ));
        assert!(!turnstile_response(
            &t,
            &json!({"success":true,"hostname":"example.org","action":"test"})
        ));
        // The global budget also bounds persistent peer rows.
        let bounded = Auth::open(&temp.path().join("bounded")).unwrap();
        bounded.initialize("admin", "long password").unwrap();
        for i in 0..100 {
            let _ = bounded.attempt(&format!("peer-{i}"));
        }
        let peers: i64 = bounded
            .connection()
            .unwrap()
            .query_row("SELECT count(*) FROM attempts", [], |r| r.get(0))
            .unwrap();
        assert!(peers <= 61);
        a.connection()
            .unwrap()
            .execute("DELETE FROM users", [])
            .unwrap();
        assert!(a.provision(None, None, None).is_err());
    }
    #[test]
    fn concurrent_setup_is_single_identity() {
        let temp = tempfile::tempdir().unwrap();
        let a = Auth::open(temp.path()).unwrap();
        let b = a.clone();
        let worker = std::thread::spawn(move || b.setup("second", "second password"));
        let first = a.setup("first", "first password").is_ok();
        let second = worker.join().unwrap().is_ok();
        assert_ne!(first, second);
        assert_eq!(
            a.status().unwrap()["username"],
            if first { "first" } else { "second" }
        );
    }
    #[test]
    fn lost_store_does_not_reprovision_and_secret_is_private() {
        let temp = tempfile::tempdir().unwrap();
        let a = Auth::open(temp.path()).unwrap();
        a.initialize("admin", "long password").unwrap();
        a.configure(
            "admin",
            None,
            Some(Turnstile {
                enabled: false,
                secret: "private secret".into(),
                ..Turnstile::default()
            }),
        )
        .unwrap();
        assert!(!a.status().unwrap().to_string().contains("private secret"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&a.dir).unwrap().permissions().mode() & 0o777,
                0o700
            );
            assert_eq!(
                fs::metadata(a.dir.join("auth.sqlite"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        fs::remove_dir_all(&a.dir).unwrap();
        assert!(Auth::open(temp.path()).is_err());
    }
}
