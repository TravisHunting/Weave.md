//! This machine's own unicast addresses. A server listening on every interface
//! without a configured browser origin accepts only these as Host/Origin, so
//! DNS-rebinding protection survives plain-HTTP access on a local network.
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

/// Usable addresses of interfaces that are up, without loopback or link-local
/// IPv6 (whose zone identifiers browsers do not accept in an origin).
pub fn addresses() -> Vec<IpAddr> {
    let mut found: Vec<IpAddr> = raw()
        .into_iter()
        .filter(|ip| {
            !ip.is_loopback()
                && !ip.is_unspecified()
                && !ip.is_multicast()
                && match ip {
                    IpAddr::V6(v6) => (v6.segments()[0] & 0xffc0) != 0xfe80,
                    IpAddr::V4(_) => true,
                }
        })
        .collect();
    found.sort_by_key(|ip| (ip.is_ipv6(), *ip));
    found.dedup();
    found
}

#[cfg(windows)]
fn raw() -> Vec<IpAddr> {
    use windows_sys::Win32::{
        Foundation::ERROR_BUFFER_OVERFLOW,
        NetworkManagement::{
            IpHelper::{
                GetAdaptersAddresses, GAA_FLAG_SKIP_ANYCAST, GAA_FLAG_SKIP_DNS_SERVER,
                GAA_FLAG_SKIP_MULTICAST, IP_ADAPTER_ADDRESSES_LH, IP_ADAPTER_UNICAST_ADDRESS_LH,
            },
            Ndis::IfOperStatusUp,
        },
        Networking::WinSock::{AF_UNSPEC, SOCKADDR},
    };
    let flags = GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_MULTICAST | GAA_FLAG_SKIP_DNS_SERVER;
    let mut size = 16 * 1024u32;
    for _ in 0..4 {
        // u64 storage keeps the adapter records suitably aligned.
        let mut buffer = vec![0u64; (size as usize).div_ceil(8)];
        let first = buffer.as_mut_ptr().cast::<IP_ADAPTER_ADDRESSES_LH>();
        let status = unsafe {
            GetAdaptersAddresses(AF_UNSPEC as u32, flags, std::ptr::null(), first, &mut size)
        };
        if status == ERROR_BUFFER_OVERFLOW {
            continue;
        }
        if status != 0 {
            return vec![];
        }
        let mut found = vec![];
        let mut adapter: *const IP_ADAPTER_ADDRESSES_LH = first;
        while let Some(current) = unsafe { adapter.as_ref() } {
            if current.OperStatus == IfOperStatusUp {
                let mut unicast: *const IP_ADAPTER_UNICAST_ADDRESS_LH = current.FirstUnicastAddress;
                while let Some(address) = unsafe { unicast.as_ref() } {
                    let socket = address.Address.lpSockaddr as *const SOCKADDR;
                    let length = address.Address.iSockaddrLength.max(0) as usize;
                    if let Some(ip) = unsafe { from_sockaddr(socket.cast(), length) } {
                        found.push(ip);
                    }
                    unicast = address.Next as *const _;
                }
            }
            adapter = current.Next as *const _;
        }
        return found;
    }
    vec![]
}

#[cfg(unix)]
fn raw() -> Vec<IpAddr> {
    let mut list: *mut libc::ifaddrs = std::ptr::null_mut();
    if unsafe { libc::getifaddrs(&mut list) } != 0 {
        return vec![];
    }
    let mut found = vec![];
    let mut entry = list as *const libc::ifaddrs;
    while let Some(current) = unsafe { entry.as_ref() } {
        let up = current.ifa_flags & libc::IFF_UP as libc::c_uint != 0;
        if up && !current.ifa_addr.is_null() {
            let family = unsafe { (*current.ifa_addr).sa_family } as i32;
            let length = match family {
                libc::AF_INET => std::mem::size_of::<libc::sockaddr_in>(),
                libc::AF_INET6 => std::mem::size_of::<libc::sockaddr_in6>(),
                _ => 0,
            };
            if let Some(ip) = unsafe { from_sockaddr(current.ifa_addr.cast(), length) } {
                found.push(ip);
            }
        }
        entry = current.ifa_next as *const _;
    }
    unsafe { libc::freeifaddrs(list) };
    found
}

#[cfg(not(any(windows, unix)))]
fn raw() -> Vec<IpAddr> {
    vec![]
}

/// Reads an IPv4 or IPv6 socket address by its common C layout (family in the
/// first two bytes on Windows and Linux, address at offset 4 or 8).
#[cfg(any(windows, unix))]
unsafe fn from_sockaddr(socket: *const u8, length: usize) -> Option<IpAddr> {
    if socket.is_null() || length < 8 {
        return None;
    }
    let bytes = std::slice::from_raw_parts(socket, length);
    let family = family(bytes);
    if family == V4 && length >= 8 {
        let octets: [u8; 4] = bytes[4..8].try_into().ok()?;
        Some(IpAddr::V4(Ipv4Addr::from(octets)))
    } else if family == V6 && length >= 24 {
        let octets: [u8; 16] = bytes[8..24].try_into().ok()?;
        Some(IpAddr::V6(Ipv6Addr::from(octets)))
    } else {
        None
    }
}
#[cfg(windows)]
const V4: u16 = windows_sys::Win32::Networking::WinSock::AF_INET;
#[cfg(windows)]
const V6: u16 = windows_sys::Win32::Networking::WinSock::AF_INET6;
#[cfg(unix)]
const V4: u16 = libc::AF_INET as u16;
#[cfg(unix)]
const V6: u16 = libc::AF_INET6 as u16;
#[cfg(all(
    unix,
    not(any(target_os = "macos", target_os = "ios", target_os = "freebsd"))
))]
fn family(bytes: &[u8]) -> u16 {
    u16::from_ne_bytes([bytes[0], bytes[1]])
}
#[cfg(any(target_os = "macos", target_os = "ios", target_os = "freebsd"))]
fn family(bytes: &[u8]) -> u16 {
    bytes[1] as u16
}
#[cfg(windows)]
fn family(bytes: &[u8]) -> u16 {
    u16::from_ne_bytes([bytes[0], bytes[1]])
}

#[cfg(test)]
mod tests {
    #[test]
    fn addresses_are_routable_unicast() {
        for ip in super::addresses() {
            assert!(!ip.is_loopback() && !ip.is_unspecified() && !ip.is_multicast());
        }
    }
}
