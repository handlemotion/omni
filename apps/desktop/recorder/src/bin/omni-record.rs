//! `omni-record`: the recorder without the app, for trying it on a Mac or a Windows machine
//! and for the end-to-end test that kills it mid-meeting.
//!
//! ```text
//! omni-record record <root> <meetingId> <memberId> <folderId> [--seconds N] [--synthetic]
//!                    [--pause-at S --resume-at S]   # seconds from the start
//! omni-record list <root>               # recovers what a crash left, prints them as JSON
//! omni-record part <root> <id> <n> <partSize>   # raw bytes on stdout
//! omni-record mark <root> <id> [--upload <uploadId>] [--node <nodeId>]
//! omni-record discard <root> <id>
//! ```

use std::io::{self, Write};
use std::path::Path;
use std::process::ExitCode;
use std::thread;
use std::time::Duration;

use omni_recorder::capture::Source;
use omni_recorder::{NewRecording, Recorder, find, recover_left};

fn flag(args: &[String], name: &str) -> Option<String> {
    let at = args.iter().position(|a| a == name)?;
    args.get(at + 1).cloned()
}

fn print(value: &impl serde::Serialize) -> io::Result<()> {
    let mut out = io::stdout().lock();
    serde_json::to_writer(&mut out, value)?;
    writeln!(out)?;
    out.flush()
}

fn record(args: &[String]) -> io::Result<()> {
    let [root, meeting_id, member_id, folder_id, ..] = args else {
        return Err(io::Error::other(
            "record <root> <meetingId> <memberId> <folderId>",
        ));
    };
    let source = if args.iter().any(|a| a == "--synthetic") {
        Source::Synthetic
    } else {
        Source::Device
    };
    let new = NewRecording {
        meeting_id: meeting_id.clone(),
        member_id: member_id.clone(),
        folder_id: folder_id.clone(),
        title: flag(args, "--title"),
    };
    let recorder = Recorder::start(Path::new(root), new, source, Box::new(|_| {}))
        .map_err(|e| io::Error::other(format!("{e:?}")))?;
    print(&recorder.snapshot())?;
    let tenths = |name: &str| {
        flag(args, name)
            .and_then(|s| s.parse::<u64>().ok())
            .map(|s| s * 10)
    };
    let (pause_at, resume_at) = (tenths("--pause-at"), tenths("--resume-at"));
    for tenth in 0..tenths("--seconds").unwrap_or(u64::MAX) {
        if recorder.is_finished() {
            break;
        }
        if Some(tenth) == pause_at {
            recorder.pause();
        }
        if Some(tenth) == resume_at {
            recorder.resume();
        }
        thread::sleep(Duration::from_millis(100));
    }
    print(&recorder.stop()?)
}

fn run(args: &[String]) -> io::Result<()> {
    let root = |i: usize| {
        args.get(i)
            .map(Path::new)
            .ok_or_else(|| io::Error::other("<root>"))
    };
    let id = |i: usize| args.get(i).cloned().unwrap_or_default();
    match args.first().map(String::as_str) {
        Some("record") => record(&args[1..]),
        Some("list") => {
            let spools = recover_left(root(1)?, None)?;
            print(
                &spools
                    .iter()
                    .map(|s| s.snapshot(-120.0))
                    .collect::<Vec<_>>(),
            )
        }
        Some("part") => {
            let n = id(3).parse().map_err(io::Error::other)?;
            let size = id(4).parse().map_err(io::Error::other)?;
            let part = find(root(1)?, &id(2))?.read_part(n, size)?;
            io::stdout().lock().write_all(&part)
        }
        Some("mark") => find(root(1)?, &id(2))?.mark(flag(args, "--upload"), flag(args, "--node")),
        Some("discard") => find(root(1)?, &id(2))?.remove(),
        _ => Err(io::Error::other(
            "usage: omni-record record|list|part|mark|discard …",
        )),
    }
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match run(&args) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("omni-record: {error}");
            ExitCode::FAILURE
        }
    }
}
