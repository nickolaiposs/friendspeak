// friendspeak-media: the desktop app's native media sidecar (D45).
//
// Captures a screen, window or camera with the OS's own APIs, encodes H.264
// (in hardware where it can) and sends it to each viewer over standard WebRTC.
// The app starts it as a child process and talks to it in JSON lines on
// stdin/stdout (proto.rs); it relays the WebRTC signaling to the viewers.
mod audio;
mod encode;
mod engine;
mod frame;
mod ladder;
mod net;
mod proto;
mod source;

use std::io::BufRead;
use std::sync::mpsc;

fn main() {
    if std::env::args().nth(1).as_deref() == Some("--version") {
        println!("{}", env!("CARGO_PKG_VERSION"));
        return;
    }
    let (tx, rx) = mpsc::channel::<engine::Msg>();
    let cmds = tx.clone();
    std::thread::Builder::new()
        .name("stdin".into())
        .spawn(move || {
            for line in std::io::stdin().lock().lines() {
                let Ok(line) = line else { break };
                if line.trim().is_empty() {
                    continue;
                }
                match serde_json::from_str::<proto::Cmd>(&line) {
                    Ok(cmd) => {
                        if cmds.send(engine::Msg::Cmd(cmd)).is_err() {
                            return;
                        }
                    }
                    Err(e) => log!("bad command: {e}: {line}"),
                }
            }
            // The app is gone (or closed our stdin): nothing left to stream to
            let _ = cmds.send(engine::Msg::Cmd(proto::Cmd::Quit));
        })
        .expect("stdin thread");
    engine::run(tx, rx);
}
