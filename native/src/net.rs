// UDP for a share's publishing connection: one socket per local IPv4 address (ICE host candidates) and a
// reader thread each. The SFU is ICE-lite and answers the checks we send it, so it learns our address
// from them: there is no STUN of our own to do. Everything else on the wire is str0m's.
use std::net::{IpAddr, Ipv4Addr, SocketAddr, SocketAddrV4, UdpSocket};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::Sender;
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::engine::Msg;
use crate::proto::Kind;

// Packets read and not yet handled by the engine. Past the limit the readers drop what arrives, as a
// full socket buffer would, so a flood can't grow the engine's queue without bound.
pub static QUEUED: AtomicUsize = AtomicUsize::new(0);
const QUEUE_LIMIT: usize = 4096;
// The send buffer of each socket: a keyframe of a 2160p layer is hundreds of packets, and the pacer sends what is
// due in a burst. A send that finds the buffer full fails, and is counted (D71).
const SEND_BUFFER: i32 = 4 << 20;

pub struct Sockets {
    pub list: Vec<(SocketAddr, Arc<UdpSocket>)>,
    stop: Arc<AtomicBool>,
    errors: AtomicU64, // sends that failed
}

impl Drop for Sockets {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

impl Sockets {
    pub fn send(&self, from: SocketAddr, to: SocketAddr, data: &[u8]) {
        if let Some((_, s)) = self.list.iter().find(|(a, _)| *a == from).or(self.list.first()) {
            if s.send_to(data, to).is_err() {
                self.errors.fetch_add(1, Ordering::Relaxed);
            }
        }
    }

    pub fn errors(&self) -> u64 {
        self.errors.load(Ordering::Relaxed)
    }
}

// Best effort: the OS may hold it to less
#[cfg(target_os = "windows")]
fn send_buffer(sock: &UdpSocket) {
    use std::os::windows::io::AsRawSocket;
    use windows::Win32::Networking::WinSock::{setsockopt, SOCKET, SOL_SOCKET, SO_SNDBUF};
    // SAFETY: a live socket, and an option that takes a 4-byte integer
    unsafe {
        let _ = setsockopt(SOCKET(sock.as_raw_socket() as usize), SOL_SOCKET, SO_SNDBUF, Some(&SEND_BUFFER.to_ne_bytes()));
    }
}

#[cfg(unix)]
fn send_buffer(sock: &UdpSocket) {
    use std::os::fd::AsRawFd;
    extern "C" {
        fn setsockopt(fd: i32, level: i32, name: i32, value: *const std::ffi::c_void, len: u32) -> i32;
    }
    #[cfg(target_os = "macos")]
    const LEVEL_NAME: (i32, i32) = (0xffff, 0x1001); // SOL_SOCKET, SO_SNDBUF
    #[cfg(not(target_os = "macos"))]
    const LEVEL_NAME: (i32, i32) = (1, 7);
    // SAFETY: a live socket, and an option that takes a 4-byte integer
    unsafe {
        setsockopt(sock.as_raw_fd(), LEVEL_NAME.0, LEVEL_NAME.1, &SEND_BUFFER as *const i32 as *const std::ffi::c_void, 4);
    }
}

// The machine's IPv4 addresses, and loopback for a server on this machine
fn local_ipv4() -> Vec<Ipv4Addr> {
    let mut out: Vec<Ipv4Addr> = if_addrs::get_if_addrs()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|i| match i.ip() {
            IpAddr::V4(v4) if !v4.is_loopback() && !v4.is_link_local() => Some(v4),
            _ => None,
        })
        .collect();
    out.push(Ipv4Addr::LOCALHOST);
    out.dedup();
    out
}

// Sockets for one share's connection to the SFU
pub fn open(kind: Kind, tx: &Sender<Msg>) -> std::io::Result<Sockets> {
    let stop = Arc::new(AtomicBool::new(false));
    let mut list = Vec::new();
    for ip in local_ipv4() {
        let Ok(sock) = UdpSocket::bind(SocketAddrV4::new(ip, 0)) else { continue };
        sock.set_read_timeout(Some(Duration::from_millis(250)))?;
        send_buffer(&sock);
        let local = sock.local_addr()?;
        let sock = Arc::new(sock);
        let (rd, tx, stop) = (sock.clone(), tx.clone(), stop.clone());
        std::thread::Builder::new().name("udp".into()).spawn(move || {
            let mut buf = vec![0u8; 2000];
            while !stop.load(Ordering::Relaxed) {
                match rd.recv_from(&mut buf) {
                    Ok((n, src)) => {
                        if QUEUED.load(Ordering::Relaxed) > QUEUE_LIMIT {
                            continue;
                        }
                        QUEUED.fetch_add(1, Ordering::Relaxed);
                        let msg = Msg::Packet { kind, local, src, data: buf[..n].to_vec(), at: Instant::now() };
                        if tx.send(msg).is_err() {
                            return;
                        }
                    }
                    Err(e) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {}
                    // Windows reports an ICMP "port unreachable" from an earlier send here
                    Err(e) if e.kind() == std::io::ErrorKind::ConnectionReset => {}
                    Err(_) => std::thread::sleep(Duration::from_millis(50)),
                }
            }
        })?;
        list.push((local, sock));
    }
    if list.is_empty() {
        return Err(std::io::Error::other("no local address to bind"));
    }
    Ok(Sockets { list, stop, errors: AtomicU64::new(0) })
}
