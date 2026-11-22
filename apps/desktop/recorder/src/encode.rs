//! Stereo Opus in Ogg (RFC 7845) at 32 kbit/s: left is the microphone, right the computer's
//! sound. A page holds 200 ms and is written as soon as it is full, so a process killed
//! mid-meeting loses at most that much (the kernel keeps what was written).

use std::io::{self, Write};

use opus::{Application, Bitrate, Channels, Encoder};

use crate::ogg::{self, BEGINNING, END};

pub const RATE: u32 = 48_000;
/// 20 ms at 48 kHz, per channel.
pub const FRAME: usize = 960;
const BITRATE: i32 = 32_000;
const PACKETS_PER_PAGE: usize = 10;
/// libopus' lookahead at 48 kHz, written as the stream's pre-skip.
const PRE_SKIP: u16 = 312;

/// One frame: 960 interleaved stereo samples, left first.
pub type Frame = [f32; FRAME * 2];

pub struct OggOpusWriter<W: Write> {
    out: W,
    encoder: Encoder,
    serial: u32,
    sequence: u32,
    granule: u64,
    pending: Vec<Vec<u8>>,
}

fn opus_error(error: opus::Error) -> io::Error {
    io::Error::other(error.to_string())
}

fn head() -> Vec<u8> {
    let mut head = b"OpusHead".to_vec();
    head.push(1);
    head.push(2);
    head.extend_from_slice(&PRE_SKIP.to_le_bytes());
    head.extend_from_slice(&RATE.to_le_bytes());
    head.extend_from_slice(&0_i16.to_le_bytes());
    head.push(0);
    head
}

fn tags() -> Vec<u8> {
    let vendor = b"omni-recorder";
    let mut tags = b"OpusTags".to_vec();
    tags.extend_from_slice(&(vendor.len() as u32).to_le_bytes());
    tags.extend_from_slice(vendor);
    tags.extend_from_slice(&0_u32.to_le_bytes());
    tags
}

impl<W: Write> OggOpusWriter<W> {
    /// Writes the two header pages and gets ready for audio.
    pub fn new(mut out: W, serial: u32) -> io::Result<Self> {
        let mut encoder =
            Encoder::new(RATE, Channels::Stereo, Application::Voip).map_err(opus_error)?;
        encoder
            .set_bitrate(Bitrate::Bits(BITRATE))
            .map_err(opus_error)?;
        out.write_all(&ogg::page(serial, 0, 0, BEGINNING, &[head()]))?;
        out.write_all(&ogg::page(serial, 1, 0, 0, &[tags()]))?;
        out.flush()?;
        Ok(Self {
            out,
            encoder,
            serial,
            sequence: 2,
            granule: u64::from(PRE_SKIP),
            pending: Vec::with_capacity(PACKETS_PER_PAGE),
        })
    }

    /// Audio written so far, in milliseconds.
    pub fn duration_ms(&self) -> u64 {
        (self.granule - u64::from(PRE_SKIP)) * 1000 / u64::from(RATE)
    }

    pub fn push(&mut self, frame: &Frame) -> io::Result<()> {
        let packet = self
            .encoder
            .encode_vec_float(frame, 1500)
            .map_err(opus_error)?;
        self.granule += FRAME as u64;
        self.pending.push(packet);
        if self.pending.len() == PACKETS_PER_PAGE {
            self.write_page(0)?;
        }
        Ok(())
    }

    fn write_page(&mut self, flags: u8) -> io::Result<()> {
        let page = ogg::page(
            self.serial,
            self.sequence,
            self.granule,
            flags,
            &self.pending,
        );
        self.sequence += 1;
        self.pending.clear();
        self.out.write_all(&page)?;
        self.out.flush()
    }

    /// Writes what is left and marks the end of the stream.
    pub fn finish(mut self) -> io::Result<W> {
        self.write_page(END)?;
        Ok(self.out)
    }

    pub fn get_mut(&mut self) -> &mut W {
        &mut self.out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ogg::pages;

    fn tone(n: usize) -> Frame {
        let mut frame = [0.0; FRAME * 2];
        for (i, s) in frame.iter_mut().enumerate() {
            *s = ((n * FRAME + i / 2) as f32 * 0.05).sin() * 0.3;
        }
        frame
    }

    // Bug: the duration sent to the server comes from the granule; off by the pre-skip, every
    // mic interval would be misplaced against the transcript.
    #[test]
    fn granule_counts_samples_after_pre_skip() {
        let mut writer = OggOpusWriter::new(Vec::new(), 1).unwrap();
        for n in 0..25 {
            writer.push(&tone(n)).unwrap();
        }
        assert_eq!(writer.duration_ms(), 500);
        let bytes = writer.finish().unwrap();
        let found = pages(&bytes);
        assert_eq!(found.len(), 2 + 3, "headers, two full pages, the rest");
        let last = found.last().unwrap();
        assert_eq!(last.granule, 312 + 25 * 960);
        assert_eq!(last.flags & END, END);
    }

    // Bug: a page held in memory until the recording ends would be lost by a crash.
    #[test]
    fn a_full_page_is_written_at_once() {
        let mut writer = OggOpusWriter::new(Vec::new(), 1).unwrap();
        let headers = writer.get_mut().len();
        for n in 0..9 {
            writer.push(&tone(n)).unwrap();
        }
        assert_eq!(writer.get_mut().len(), headers);
        writer.push(&tone(9)).unwrap();
        assert_eq!(pages(writer.get_mut()).len(), 3);
    }
}
