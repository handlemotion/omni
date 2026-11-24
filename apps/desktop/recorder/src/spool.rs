//! The spool: one folder per recording, kept until its upload is done (docs/spec/meetings.md,
//! "Nothing is lost").
//!
//! - `audio.ogg`: the recording as it is encoded, page by page.
//! - `video.mp4` (macOS, when the person picked a window or display): fragmented MP4 on the
//!   audio's clock, appended a whole fragment at a time (`video.rs`).
//! - `recording.json`: what it is for and how far it got, rewritten whole (write, then rename).
//! - `mic.spans`: a `start` line when a mic interval opens and a `start end` line when it
//!   closes, appended; an interval still open at a crash runs to the file's end.
//!
//! A folder whose manifest is not `stopped` was left by a crash, a sleep that never woke or a
//! quit: `recover` cuts its audio at the last whole page and its video after the last whole
//! fragment, and stops it, and it uploads like any other.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use omni_sync_types::desktop_recorder::{Cut, DesktopRecording, DesktopRecordingState, MicSpan};
use serde::{Deserialize, Serialize};

use crate::detect::Span;
use crate::encode::RATE;
use crate::{ogg, video};

const MANIFEST: &str = "recording.json";
const AUDIO: &str = "audio.ogg";
const VIDEO: &str = "video.mp4";
const SPANS: &str = "mic.spans";
const PRE_SKIP: u64 = 312;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum State {
    Recording,
    Paused,
    Stopped,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub id: String,
    pub meeting_id: String,
    pub member_id: String,
    pub folder_id: String,
    pub title: Option<String>,
    pub started_at_ms: u64,
    pub state: State,
    pub duration_ms: u64,
    pub cuts: Vec<(u64, u64)>,
    pub upload_id: Option<String>,
    pub node_id: Option<String>,
    /// The video's upload and file, as for the audio; absent from a spool older than video.
    #[serde(default)]
    pub video_upload_id: Option<String>,
    #[serde(default)]
    pub video_node_id: Option<String>,
}

/// Which of a spool's files.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SpoolFile {
    Audio,
    Video,
}

/// What finishing has got to: the upload a file goes up as, and the file it became.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Progress {
    pub upload_id: Option<String>,
    pub node_id: Option<String>,
    pub video_upload_id: Option<String>,
    pub video_node_id: Option<String>,
}

/// What a new recording is for: the meeting `POST /api/meetings` made.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewRecording {
    pub meeting_id: String,
    pub member_id: String,
    pub folder_id: String,
    pub title: Option<String>,
}

pub struct Spool {
    dir: PathBuf,
    pub manifest: Manifest,
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let temp = path.with_extension("tmp");
    let mut file = File::create(&temp)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    fs::rename(temp, path)
}

/// The closed spans, and where an interval still open at the end began. A line cut short by a
/// crash reads as nothing.
fn parse_spans(text: &str) -> (Vec<Span>, Option<u64>) {
    let mut spans = Vec::new();
    let mut open = None;
    for line in text.lines() {
        let mut numbers = line.split(' ').map(str::parse::<u64>);
        match (numbers.next(), numbers.next(), numbers.next()) {
            (Some(Ok(start)), None, None) => open = Some(start),
            (Some(Ok(start_ms)), Some(Ok(end_ms)), None) if end_ms > start_ms => {
                spans.push(Span { start_ms, end_ms });
                open = None;
            }
            _ => {}
        }
    }
    (spans, open)
}

impl Spool {
    /// A new, empty recording under `root`. Refused when the meeting already has one here: a
    /// meeting is recorded once, and two spools would upload two files for it.
    pub fn create(root: &Path, new: NewRecording) -> io::Result<Self> {
        if list(root)?
            .iter()
            .any(|s| s.manifest.meeting_id == new.meeting_id)
        {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "this meeting is already recorded on this computer",
            ));
        }
        let id = uuid::Uuid::new_v4().to_string();
        let dir = root.join(&id);
        fs::create_dir_all(&dir)?;
        let spool = Self {
            dir,
            manifest: Manifest {
                id,
                meeting_id: new.meeting_id,
                member_id: new.member_id,
                folder_id: new.folder_id,
                title: new.title,
                started_at_ms: now_ms(),
                state: State::Recording,
                duration_ms: 0,
                cuts: Vec::new(),
                upload_id: None,
                node_id: None,
                video_upload_id: None,
                video_node_id: None,
            },
        };
        spool.save()?;
        Ok(spool)
    }

    pub fn open(dir: &Path) -> io::Result<Self> {
        let manifest = serde_json::from_slice(&fs::read(dir.join(MANIFEST))?)?;
        Ok(Self {
            dir: dir.to_path_buf(),
            manifest,
        })
    }

    pub fn audio_path(&self) -> PathBuf {
        self.dir.join(AUDIO)
    }

    pub fn video_path(&self) -> PathBuf {
        self.dir.join(VIDEO)
    }

    fn path(&self, file: SpoolFile) -> PathBuf {
        match file {
            SpoolFile::Audio => self.audio_path(),
            SpoolFile::Video => self.video_path(),
        }
    }

    /// Cuts the video after its last whole fragment, and deletes one that has none. Safe to
    /// run on a video already settled.
    pub fn settle_video(&self) -> io::Result<()> {
        let path = self.video_path();
        let mut file = match OpenOptions::new().read(true).write(true).open(&path) {
            Ok(file) => file,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(e),
        };
        let len = file.metadata()?.len();
        let playable = video::playable_len(&mut file, len)?;
        if playable == 0 {
            drop(file);
            return fs::remove_file(path);
        }
        if playable < len {
            file.set_len(playable)?;
            file.sync_all()?;
        }
        Ok(())
    }

    pub fn save(&self) -> io::Result<()> {
        let bytes = serde_json::to_vec_pretty(&self.manifest)?;
        write_atomic(&self.dir.join(MANIFEST), &bytes)
    }

    fn append_line(&self, line: &str) -> io::Result<()> {
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.dir.join(SPANS))?;
        writeln!(file, "{line}")
    }

    /// The person began speaking at `start_ms`; kept so a crash mid-sentence still counts it.
    pub fn open_span(&self, start_ms: u64) -> io::Result<()> {
        self.append_line(&start_ms.to_string())
    }

    pub fn append_span(&self, span: Span) -> io::Result<()> {
        self.append_line(&format!("{} {}", span.start_ms, span.end_ms))
    }

    pub fn spans(&self) -> Vec<Span> {
        let text = fs::read_to_string(self.dir.join(SPANS)).unwrap_or_default();
        parse_spans(&text).0
    }

    pub fn size(&self) -> u64 {
        fs::metadata(self.audio_path()).map_or(0, |m| m.len())
    }

    pub fn video_size(&self) -> u64 {
        fs::metadata(self.video_path()).map_or(0, |m| m.len())
    }

    /// Stops a recording the app did not stop itself: the file ends at its last whole page,
    /// and spans past its end are cut to it. Nothing to do for one already stopped.
    pub fn recover(&mut self) -> io::Result<()> {
        if self.manifest.state == State::Stopped {
            return Ok(());
        }
        let path = self.audio_path();
        let mut bytes = fs::read(&path).unwrap_or_default();
        let granule = match ogg::repair(&mut bytes) {
            Some(repaired) => {
                write_atomic(&path, &bytes)?;
                repaired.granule
            }
            // Not even the headers reached the disk: an empty recording, nothing to upload.
            None => {
                fs::write(&path, [])?;
                PRE_SKIP
            }
        };
        self.manifest.duration_ms = granule.saturating_sub(PRE_SKIP) * 1000 / u64::from(RATE);
        let end = self.manifest.duration_ms;
        let text = fs::read_to_string(self.dir.join(SPANS)).unwrap_or_default();
        let (mut spans, open) = parse_spans(&text);
        spans.extend(open.map(|start_ms| Span {
            start_ms,
            end_ms: end,
        }));
        let spans: Vec<Span> = spans
            .into_iter()
            .filter(|s| s.start_ms < end)
            .map(|s| Span {
                start_ms: s.start_ms,
                end_ms: s.end_ms.min(end),
            })
            .collect();
        let text: String = spans
            .iter()
            .map(|s| format!("{} {}\n", s.start_ms, s.end_ms))
            .collect();
        write_atomic(&self.dir.join(SPANS), text.as_bytes())?;
        self.settle_video()?;
        self.manifest.state = State::Stopped;
        self.save()
    }

    /// Part `number` (from 1) of a stopped recording's `file`, in Drive's parts of `part_size`
    /// bytes.
    pub fn read_part(&self, file: SpoolFile, number: u64, part_size: u64) -> io::Result<Vec<u8>> {
        if self.manifest.state != State::Stopped {
            return Err(io::Error::other("the recording is still going"));
        }
        if number == 0 || part_size == 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "parts count from 1",
            ));
        }
        let offset = (number - 1) * part_size;
        let size = fs::metadata(self.path(file)).map_or(0, |m| m.len());
        let len = size.saturating_sub(offset).min(part_size);
        let mut file = File::open(self.path(file))?;
        file.seek(SeekFrom::Start(offset))?;
        let mut part = vec![0; len as usize];
        file.read_exact(&mut part)?;
        Ok(part)
    }

    /// Notes how far the uploads got, so a restart carries on from there. What is not given
    /// stays as it was.
    pub fn mark(&mut self, progress: Progress) -> io::Result<()> {
        let m = &mut self.manifest;
        for (from, to) in [
            (progress.upload_id, &mut m.upload_id),
            (progress.node_id, &mut m.node_id),
            (progress.video_upload_id, &mut m.video_upload_id),
            (progress.video_node_id, &mut m.video_node_id),
        ] {
            if from.is_some() {
                *to = from;
            }
        }
        self.save()
    }

    /// Deletes the spool, once the meeting has its file.
    pub fn remove(self) -> io::Result<()> {
        fs::remove_dir_all(self.dir)
    }

    pub fn snapshot(&self, mic_db: f64) -> DesktopRecording {
        let m = &self.manifest;
        DesktopRecording {
            id: m.id.clone(),
            meeting_id: m.meeting_id.clone(),
            member_id: m.member_id.clone(),
            folder_id: m.folder_id.clone(),
            title: m.title.clone(),
            state: match m.state {
                State::Recording => DesktopRecordingState::Recording,
                State::Paused => DesktopRecordingState::Paused,
                State::Stopped => DesktopRecordingState::Stopped,
            },
            started_at_ms: m.started_at_ms as i64,
            duration_ms: m.duration_ms as i64,
            size: self.size() as i64,
            mic_spans: self
                .spans()
                .into_iter()
                .map(|s| MicSpan {
                    start_ms: s.start_ms as i64,
                    end_ms: s.end_ms as i64,
                })
                .collect(),
            cuts: m
                .cuts
                .iter()
                .map(|&(at_ms, dropped_ms)| Cut {
                    at_ms: at_ms as i64,
                    dropped_ms: dropped_ms as i64,
                })
                .collect(),
            upload_id: m.upload_id.clone(),
            node_id: m.node_id.clone(),
            video_size: Some(self.video_size() as i64),
            video_upload_id: m.video_upload_id.clone(),
            video_node_id: m.video_node_id.clone(),
            mic_db,
        }
    }
}

/// Every recording under `root`, oldest first. Folders without a readable manifest are skipped.
pub fn list(root: &Path) -> io::Result<Vec<Spool>> {
    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e),
    };
    let mut spools: Vec<Spool> = entries
        .filter_map(Result::ok)
        .filter_map(|entry| Spool::open(&entry.path()).ok())
        .collect();
    spools.sort_by_key(|s| s.manifest.started_at_ms);
    Ok(spools)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("omni-spool-{name}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn new(meeting: &str) -> NewRecording {
        NewRecording {
            meeting_id: meeting.into(),
            member_id: "member".into(),
            folder_id: "folder".into(),
            title: None,
        }
    }

    // Bug: two spools for one meeting would upload two files and the second stop would point
    // the meeting at a different recording than the first.
    #[test]
    fn a_meeting_is_spooled_once() {
        let root = root("once");
        Spool::create(&root, new("m1")).unwrap();
        let again = Spool::create(&root, new("m1")).err().unwrap();
        assert_eq!(again.kind(), io::ErrorKind::AlreadyExists);
        assert!(Spool::create(&root, new("m2")).is_ok());
    }

    // Bug: a mic span half-written at the crash would be read as a bogus interval, and one
    // still being spoken would be dropped, crediting the recorder's words to nobody.
    #[test]
    fn a_cut_line_is_skipped_and_an_open_span_is_kept() {
        let span = |start_ms, end_ms| Span { start_ms, end_ms };
        assert_eq!(
            parse_spans("0\n0 1500\n2500\n2500 4000\n5000\n5000 6"),
            (vec![span(0, 1500), span(2500, 4000)], Some(5000))
        );
        assert_eq!(
            parse_spans("0 1500\n2500\n"),
            (vec![span(0, 1500)], Some(2500))
        );
    }

    // Bug: parts read with an off-by-one offset upload a file that is not the recording.
    #[test]
    fn parts_tile_the_file() {
        let root = root("parts");
        let mut spool = Spool::create(&root, new("m")).unwrap();
        let bytes: Vec<u8> = (0..=255).cycle().take(1000).collect();
        fs::write(spool.audio_path(), &bytes).unwrap();
        fs::write(spool.video_path(), &bytes[..700]).unwrap();
        assert!(
            spool.read_part(SpoolFile::Audio, 1, 300).is_err(),
            "not while recording"
        );
        spool.manifest.state = State::Stopped;
        let parts: Vec<u8> = (1..=4)
            .flat_map(|n| spool.read_part(SpoolFile::Audio, n, 300).unwrap())
            .collect();
        assert_eq!(parts, bytes);
        assert_eq!(
            spool.read_part(SpoolFile::Audio, 4, 300).unwrap().len(),
            100
        );
        let video: Vec<u8> = (1..=3)
            .flat_map(|n| spool.read_part(SpoolFile::Video, n, 300).unwrap())
            .collect();
        assert_eq!(video, &bytes[..700]);
    }

    // Bug: progress kept only in memory would make a restart open a second upload.
    #[test]
    fn upload_progress_survives_reopening() {
        let root = root("mark");
        let mut spool = Spool::create(&root, new("m")).unwrap();
        let mark = |spool: &mut Spool, progress| spool.mark(progress).unwrap();
        mark(
            &mut spool,
            Progress {
                upload_id: Some("up".into()),
                ..Progress::default()
            },
        );
        mark(
            &mut spool,
            Progress {
                node_id: Some("node".into()),
                ..Progress::default()
            },
        );
        mark(
            &mut spool,
            Progress {
                video_node_id: Some("video".into()),
                ..Progress::default()
            },
        );
        let reopened = Spool::open(&root.join(&spool.manifest.id)).unwrap();
        assert_eq!(reopened.manifest.upload_id.as_deref(), Some("up"));
        assert_eq!(reopened.manifest.node_id.as_deref(), Some("node"));
        assert_eq!(reopened.manifest.video_node_id.as_deref(), Some("video"));
    }

    // Bug: a crash mid-fragment left a video the browser stops at, or refuses; and a video with
    // no frames yet uploaded as a file that shows nothing.
    #[test]
    fn recovering_cuts_the_video_after_its_last_whole_fragment() {
        let boxed = |kind: &[u8; 4], body: usize| {
            let mut out = u32::try_from(8 + body).unwrap().to_be_bytes().to_vec();
            out.extend(kind);
            out.extend(std::iter::repeat_n(0, body));
            out
        };
        let root = root("video");
        let mut spool = Spool::create(&root, new("m")).unwrap();
        let mut whole = boxed(b"ftyp", 20);
        whole.extend(boxed(b"moov", 600));
        whole.extend(boxed(b"moof", 100));
        whole.extend(boxed(b"mdat", 900));
        let mut cut = whole.clone();
        cut.extend(&boxed(b"moof", 100)[..50]);
        fs::write(spool.video_path(), &cut).unwrap();
        spool.recover().unwrap();
        assert_eq!(fs::read(spool.video_path()).unwrap(), whole);

        let mut header_only = Spool::create(&root, new("m2")).unwrap();
        fs::write(header_only.video_path(), &whole[..28 + 608]).unwrap();
        header_only.recover().unwrap();
        assert!(!header_only.video_path().exists());
        assert_eq!(header_only.snapshot(-120.0).video_size, Some(0));
    }

    // Bug: a crash before any audio reached the disk must still end as a stopped, empty
    // recording, or the app would retry it forever.
    #[test]
    fn recovering_nothing_stops_an_empty_recording() {
        let root = root("empty");
        let mut spool = Spool::create(&root, new("m")).unwrap();
        spool.recover().unwrap();
        assert_eq!(spool.manifest.state, State::Stopped);
        assert_eq!((spool.manifest.duration_ms, spool.size()), (0, 0));
    }
}
