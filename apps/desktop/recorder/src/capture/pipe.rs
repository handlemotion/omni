//! What `omni-capture` (the macOS helper) writes on stdout: one `R` byte once both streams
//! run, then chunks of a tag byte (`M` mic, `S` the computer's sound), a little-endian `u32`
//! sample count and that many little-endian `f32` samples, mono at 48 kHz.

use std::io::{self, Read};

use super::Chunk;

pub const READY: u8 = b'R';
/// Most samples one chunk may claim: a second. More means the pipe is out of step.
const MAX_SAMPLES: usize = 48_000;

/// The next chunk, or `None` at a clean end of the stream.
pub fn read_chunk(reader: &mut impl Read) -> io::Result<Option<Chunk>> {
    let mut tag = [0_u8; 1];
    if reader.read(&mut tag)? == 0 {
        return Ok(None);
    }
    let mut count = [0_u8; 4];
    reader.read_exact(&mut count)?;
    let count = u32::from_le_bytes(count) as usize;
    if count > MAX_SAMPLES {
        return Err(io::Error::other(
            "the capture helper sent a chunk out of step",
        ));
    }
    let mut bytes = vec![0_u8; count * 4];
    reader.read_exact(&mut bytes)?;
    let samples = bytes
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
        .collect();
    match tag[0] {
        b'M' => Ok(Some(Chunk::Mic(samples))),
        b'S' => Ok(Some(Chunk::System(samples))),
        other => Err(io::Error::other(format!("unknown chunk {other}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chunk(tag: u8, samples: &[f32]) -> Vec<u8> {
        let mut out = vec![tag];
        out.extend((samples.len() as u32).to_le_bytes());
        for s in samples {
            out.extend(s.to_le_bytes());
        }
        out
    }

    // Bug: reading the two channels with their tags swapped puts the call on the mic channel
    // and names the wrong person as the recorder.
    #[test]
    fn chunks_keep_their_channel_and_samples() {
        let mut bytes = chunk(b'M', &[0.5, -0.5]);
        bytes.extend(chunk(b'S', &[0.25]));
        let mut reader = bytes.as_slice();
        let Some(Chunk::Mic(mic)) = read_chunk(&mut reader).unwrap() else {
            panic!()
        };
        let Some(Chunk::System(system)) = read_chunk(&mut reader).unwrap() else {
            panic!()
        };
        assert_eq!((mic, system), (vec![0.5, -0.5], vec![0.25]));
        assert!(read_chunk(&mut reader).unwrap().is_none());
    }

    // Bug: a garbled length would make the reader allocate gigabytes and take the app down.
    #[test]
    fn a_length_out_of_step_is_an_error() {
        let mut bytes = vec![b'M'];
        bytes.extend(u32::MAX.to_le_bytes());
        assert!(read_chunk(&mut bytes.as_slice()).is_err());
    }
}
