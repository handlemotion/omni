//! Downloads land in the Downloads folder whole or not at all. WebKit writes straight to the path
//! it is given, so a large download (a Drive zip streams for minutes) would sit there half
//! written under its final name, and opening it early fails ("Error 79" in Archive Utility). Each
//! download is written to `<name>.download` and renamed once it finishes, as Safari does.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::webview::DownloadEvent;
use url::Url;

const PARTIAL_SUFFIX: &str = ".download";

/// A download in flight: where it is being written and the name it gets when done.
struct Pending {
    partial: PathBuf,
    target: PathBuf,
}

/// Downloads in flight, one per URL, and the URLs whose repeat was refused.
///
/// macOS reports a finished download by its URL alone, with no path, so two downloads of one URL
/// could not be told apart: the second finishing would rename the first's partial file. A repeat
/// of a URL already downloading is refused instead (the first one is still coming), and the
/// failure WebKit reports for that refusal is ignored.
#[derive(Default)]
pub struct Downloads(Mutex<State>);

#[derive(Default)]
struct State {
    pending: HashMap<Url, Pending>,
    refused: HashMap<Url, usize>,
}

impl Downloads {
    /// The `on_download` handler: whether WebKit may go ahead with the download.
    pub fn handle(&self, event: DownloadEvent<'_>) -> bool {
        match event {
            DownloadEvent::Requested { url, destination } => self.start(url, destination),
            DownloadEvent::Finished { url, success, .. } => {
                self.finish(&url, success);
                true
            }
            _ => true,
        }
    }

    fn start(&self, url: Url, destination: &mut PathBuf) -> bool {
        let mut state = self.state();
        if state.pending.contains_key(&url) {
            *state.refused.entry(url).or_default() += 1;
            return false;
        }
        let partial = unused(&with_suffix(destination, PARTIAL_SUFFIX));
        let target = std::mem::replace(destination, partial.clone());
        state.pending.insert(url, Pending { partial, target });
        true
    }

    fn finish(&self, url: &Url, success: bool) {
        let Some(Pending { partial, target }) = self.take(url, success) else {
            return;
        };
        let result = if success {
            std::fs::rename(&partial, unused(&target))
        } else {
            eprintln!("download failed: {url}");
            std::fs::remove_file(&partial)
        };
        if let Err(error) = result {
            eprintln!("download {url}: {error}");
        }
    }

    /// The download `url`'s completion belongs to, or none when it is a refused repeat's.
    fn take(&self, url: &Url, success: bool) -> Option<Pending> {
        let mut state = self.state();
        if !success && let Some(count) = state.refused.get_mut(url) {
            *count -= 1;
            if *count == 0 {
                state.refused.remove(url);
            }
            return None;
        }
        state.pending.remove(url)
    }

    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(suffix);
    path.with_file_name(name)
}

/// `path`, or `name (1).ext`, `name (2).ext`… when it is taken, the way WebKit names a repeat.
fn unused(path: &Path) -> PathBuf {
    unused_by(path, |candidate| candidate.exists())
}

fn unused_by(path: &Path, taken: impl Fn(&Path) -> bool) -> PathBuf {
    if !taken(path) {
        return path.to_path_buf();
    }
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    let (stem, ext) = name
        .split_once('.')
        .map_or((name.as_ref(), String::new()), |(stem, ext)| {
            (stem, format!(".{ext}"))
        });
    (1..)
        .map(|n| path.with_file_name(format!("{stem} ({n}){ext}")))
        .find(|candidate| !taken(candidate))
        .unwrap_or_else(|| path.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;

    // A finished download renamed onto a file that appeared meanwhile would overwrite it.
    #[test]
    fn a_taken_name_gets_a_number_before_its_extensions() {
        let taken = [PathBuf::from("/d/RAW.zip"), PathBuf::from("/d/RAW (1).zip")];
        let next = unused_by(Path::new("/d/RAW.zip"), |p| taken.iter().any(|t| t == p));
        assert_eq!(next, PathBuf::from("/d/RAW (2).zip"));
    }

    // The partial file must never carry the final name, or opening it early fails again.
    #[test]
    fn the_partial_file_keeps_the_whole_name_and_adds_the_suffix() {
        let partial = with_suffix(Path::new("/d/backup.tar.gz"), PARTIAL_SUFFIX);
        assert_eq!(partial, PathBuf::from("/d/backup.tar.gz.download"));
    }
}
