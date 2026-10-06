// UDP for the peer connections: one socket per local IPv4 address per viewer
// (ICE host candidates), a reader thread each, and just enough STUN to learn
// our public address (the server-reflexive candidate). Everything else on the
// wire is str0m's.
use std::net::{IpAddr, Ipv4Addr, SocketAddr, SocketAddrV4, ToSocketAddrs, UdpSocket};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Sender;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::engine::Msg;
use crate::proto::Kind;

pub struct Sockets {
    pub list: Vec<(SocketAddr, Arc<UdpSocket>)>,
    stop: Arc<AtomicBool>,
}

impl Drop for Sockets {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

impl Sockets {
    pub fn send(&self, from: SocketAddr, to: SocketAddr, data: &[u8]) {
        if let Some((_, s)) = self.list.iter().find(|(a, _)| *a == from).or(self.list.first()) {
            let _ = s.send_to(data, to);
        }
    }
}

fn local_ipv4(loopback: bool) -> Vec<Ipv4Addr> {
    let mut out: Vec<Ipv4Addr> = if_addrs::get_if_addrs()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|i| match i.ip() {
            IpAddr::V4(v4) if !v4.is_loopback() && !v4.is_link_local() => Some(v4),
            _ => None,
        })
        .collect();
    if loopback || out.is_empty() {
        out.push(Ipv4Addr::LOCALHOST);
    }
    out.dedup();
    out
}

// Sockets for one viewer. `loopback` adds 127.0.0.1 (our own preview).
pub fn open(kind: Kind, viewer: &str, loopback: bool, tx: &Sender<Msg>) -> std::io::Result<Sockets> {
    let stop = Arc::new(AtomicBool::new(false));
    let mut list = Vec::new();
    for ip in local_ipv4(loopback) {
        let Ok(sock) = UdpSocket::bind(SocketAddrV4::new(ip, 0)) else { continue };
        sock.set_read_timeout(Some(Duration::from_millis(250)))?;
        let local = sock.local_addr()?;
        let sock = Arc::new(sock);
        let (rd, tx, stop, viewer) = (sock.clone(), tx.clone(), stop.clone(), viewer.to_string());
        std::thread::Builder::new().name("udp".into()).spawn(move || {
            let mut buf = vec![0u8; 2000];
            while !stop.load(Ordering::Relaxed) {
                match rd.recv_from(&mut buf) {
                    Ok((n, src)) => {
                        let msg = Msg::Packet { kind, viewer: viewer.clone(), local, src, data: buf[..n].to_vec(), at: Instant::now() };
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
    Ok(Sockets { list, stop })
}

// "host:port" names to IPv4 addresses, off the engine thread (DNS can block)
pub fn resolve(names: Vec<String>, tx: Sender<Msg>) {
    let _ = std::thread::Builder::new().name("dns".into()).spawn(move || {
        let mut out: Vec<SocketAddr> = Vec::new();
        for n in names.iter().take(2) {
            if let Ok(addrs) = n.to_socket_addrs() {
                out.extend(addrs.filter(|a| a.is_ipv4()).take(1));
            }
        }
        let _ = tx.send(Msg::Stun(out));
    });
}

const MAGIC: u32 = 0x2112_A442;

// A STUN transaction id: what a binding response has to repeat to be believed, so it must not be
// guessable. `RandomState` is seeded by the OS's random source, once per process and then varied per
// instance; hashing the clock with two of them gives 16 bytes nobody outside can predict, with no extra crate.
pub fn txid() -> [u8; 12] {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    let n = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let mut bytes = [0u8; 16];
    for half in bytes.chunks_mut(8) {
        let mut h = RandomState::new().build_hasher();
        h.write_u128(n);
        h.write_u32(std::process::id());
        half.copy_from_slice(&h.finish().to_le_bytes());
    }
    let mut id = [0u8; 12];
    id.copy_from_slice(&bytes[..12]);
    id
}

// A STUN binding request (RFC 5389) with no attributes
pub fn binding_request(id: &[u8; 12]) -> [u8; 20] {
    let mut m = [0u8; 20];
    m[1] = 0x01;
    m[4..8].copy_from_slice(&MAGIC.to_be_bytes());
    m[8..20].copy_from_slice(id);
    m
}

// Our public address from a binding success response to request `id`
pub fn binding_response(data: &[u8], id: &[u8; 12]) -> Option<SocketAddr> {
    if data.len() < 20 || data[0] != 0x01 || data[1] != 0x01 || data[4..8] != MAGIC.to_be_bytes() || data[8..20] != id[..] {
        return None;
    }
    let len = u16::from_be_bytes([data[2], data[3]]) as usize;
    let mut at = 20;
    let end = (20 + len).min(data.len());
    while at + 4 <= end {
        let kind = u16::from_be_bytes([data[at], data[at + 1]]);
        let n = u16::from_be_bytes([data[at + 2], data[at + 3]]) as usize;
        let v = data.get(at + 4..at + 4 + n)?;
        // XOR-MAPPED-ADDRESS, IPv4
        if kind == 0x0020 && n >= 8 && v[1] == 0x01 {
            let port = u16::from_be_bytes([v[2], v[3]]) ^ (MAGIC >> 16) as u16;
            let ip = u32::from_be_bytes([v[4], v[5], v[6], v[7]]) ^ MAGIC;
            return Some(SocketAddr::new(IpAddr::V4(Ipv4Addr::from(ip)), port));
        }
        at += 4 + n.div_ceil(4) * 4;
    }
    None
}
