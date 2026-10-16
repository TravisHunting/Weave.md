#!/usr/bin/env bash
# For networks that inspect TLS (for example Zscaler): installs a root
# certificate that Windows already trusts into this Linux distro's trust store,
# so apt, curl, rustup, cargo, git and (through NODE_EXTRA_CA_CERTS in the
# build scripts) Node and npm can download. It changes the distro's
# system-wide trust, so run it yourself.
#
# 1. On Windows, export the public certificate (PowerShell):
#      $c = Get-ChildItem Cert:\LocalMachine\Root | Where-Object Subject -like '*Zscaler Root CA*'
#      "-----BEGIN CERTIFICATE-----`n" + [Convert]::ToBase64String($c.RawData, 'InsertLineBreaks') + "`n-----END CERTIFICATE-----" |
#        Set-Content -Encoding ascii "$env:USERPROFILE\zscaler-root-ca.crt"
# 2. In the distro:
#      sudo bash scripts/linux/import-windows-root-ca.sh /mnt/c/Users/<you>/zscaler-root-ca.crt
set -euo pipefail
source="${1:?Pass the exported certificate file, for example /mnt/c/Users/me/zscaler-root-ca.crt}"
[ "$(id -u)" -eq 0 ] || { echo "Run with sudo." >&2; exit 1; }
openssl x509 -in "$source" -noout >/dev/null 2>&1 || { echo "$source is not a PEM certificate." >&2; exit 1; }
[ "$(openssl x509 -in "$source" -noout -subject_hash)" = "$(openssl x509 -in "$source" -noout -issuer_hash)" ] \
  || { echo "$source is not a self-signed root certificate." >&2; exit 1; }
target="/usr/local/share/ca-certificates/$(basename "${source%.*}").crt"
tr -d '\r' < "$source" > "$target"
chmod 0644 "$target"
openssl x509 -in "$target" -noout -subject -fingerprint -sha1
update-ca-certificates
echo "Installed $target"
