//! Audio engine. Lives on a dedicated OS thread because rodio's `OutputStream`
//! must outlive every `Sink` it owns. Communicates via a `mpsc::Sender`.
//!
//! Each `Play` builds a fresh `Sink` keyed by reminder id and queues a
//! tone-pattern burst. `Stop` aborts that sink. The caller picks the tone
//! pattern (which sound to play) — priority only affects the repeat count
//! and interval, not the audio itself.

use std::collections::HashMap;
use std::sync::mpsc::{self, Receiver, Sender};
use std::thread;
use std::time::Duration;

use rodio::source::{SineWave, Source};
use rodio::{OutputStream, Sink};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TonePattern {
    Klaxon,
    Chime,
    Siren,
    Pulse,
}

impl TonePattern {
    pub fn from_str_or_default(s: &str) -> Self {
        match s.to_ascii_lowercase().as_str() {
            "chime" => Self::Chime,
            "siren" => Self::Siren,
            "pulse" => Self::Pulse,
            _ => Self::Klaxon,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Klaxon => "klaxon",
            Self::Chime => "chime",
            Self::Siren => "siren",
            Self::Pulse => "pulse",
        }
    }
}

#[derive(Debug)]
pub enum AudioCmd {
    Play { id: String, tone: TonePattern },
    Stop { id: String },
    Shutdown,
}

pub fn spawn_engine() -> Sender<AudioCmd> {
    let (tx, rx) = mpsc::channel();
    thread::Builder::new()
        .name("klaxon-audio".into())
        .spawn(move || engine_loop(rx))
        .expect("failed to spawn audio thread");
    tx
}

fn engine_loop(rx: Receiver<AudioCmd>) {
    let (_stream, handle) = match OutputStream::try_default() {
        Ok(s) => s,
        Err(e) => {
            log::warn!("audio output unavailable: {e} — alerts will be silent");
            while let Ok(cmd) = rx.recv() {
                if matches!(cmd, AudioCmd::Shutdown) {
                    break;
                }
            }
            return;
        }
    };

    let mut sinks: HashMap<String, Sink> = HashMap::new();

    while let Ok(cmd) = rx.recv() {
        match cmd {
            AudioCmd::Play { id, tone } => {
                if let Some(old) = sinks.remove(&id) {
                    old.stop();
                }
                let sink = match Sink::try_new(&handle) {
                    Ok(s) => s,
                    Err(e) => {
                        log::warn!("could not build audio sink: {e}");
                        continue;
                    }
                };
                append_pattern(&sink, tone);
                sinks.insert(id, sink);
            }
            AudioCmd::Stop { id } => {
                if let Some(sink) = sinks.remove(&id) {
                    sink.stop();
                }
            }
            AudioCmd::Shutdown => break,
        }

        sinks.retain(|_, s| !s.empty());
    }
}

/// Queue one burst of the chosen tone into the sink.
fn append_pattern(sink: &Sink, tone: TonePattern) {
    match tone {
        TonePattern::Klaxon => {
            // Two-tone industrial alarm. Two cycles, ~0.9s total.
            for _ in 0..2 {
                sink.append(beep(540.0, 220, 0.32));
                sink.append(beep(880.0, 220, 0.32));
            }
        }
        TonePattern::Chime => {
            // Soft descending two-tone, ~0.4s total. Calm, low-impact.
            sink.append(beep(880.0, 180, 0.22));
            sink.append(beep(660.0, 220, 0.18));
        }
        TonePattern::Siren => {
            // Tight high alternation, ~1s, urgent.
            for _ in 0..4 {
                sink.append(beep(880.0, 120, 0.42));
                sink.append(beep(1100.0, 120, 0.42));
            }
        }
        TonePattern::Pulse => {
            // Sharp single-pitch beep with short gaps. Crisp and insistent.
            for i in 0..5 {
                sink.append(beep(880.0, 80, 0.42));
                if i < 4 {
                    sink.append(silence(70));
                }
            }
        }
    }
}

fn beep(freq: f32, ms: u64, amp: f32) -> impl Source<Item = f32> + Send + 'static {
    SineWave::new(freq)
        .take_duration(Duration::from_millis(ms))
        .amplify(amp)
}

fn silence(ms: u64) -> impl Source<Item = f32> + Send + 'static {
    // rodio doesn't have a zero-source taking a duration that's trivial to
    // type; we use an amplitude-0 sine wave instead.
    SineWave::new(1.0)
        .take_duration(Duration::from_millis(ms))
        .amplify(0.0)
}
