//! Audio engine. Lives on a dedicated OS thread because rodio's `OutputStream`
//! must outlive every `Sink` it owns. Communicates via a `mpsc::Sender`.
//!
//! Each `Play` builds a fresh `Sink` keyed by reminder id and queues a
//! priority-specific tone pattern. `Stop` aborts that sink.

use std::collections::HashMap;
use std::sync::mpsc::{self, Receiver, Sender};
use std::thread;
use std::time::Duration;

use rodio::source::{SineWave, Source};
use rodio::{OutputStream, Sink};

use crate::models::Priority;

#[derive(Debug)]
pub enum AudioCmd {
    Play { id: String, priority: Priority },
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
            // Drain commands silently so the channel doesn't back up.
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
            AudioCmd::Play { id, priority } => {
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
                append_pattern(&sink, priority);
                sinks.insert(id, sink);
            }
            AudioCmd::Stop { id } => {
                if let Some(sink) = sinks.remove(&id) {
                    sink.stop();
                }
            }
            AudioCmd::Shutdown => break,
        }

        // Cull finished sinks so the map doesn't grow unbounded.
        sinks.retain(|_, s| !s.empty());
    }
}

/// Append a priority-tuned alarm burst to the sink. Shape of the burst:
///   Low    → one soft two-tone chime, ~0.4 s
///   Normal → klaxon: low/high alternation, ~0.9 s
///   High   → urgent siren: tighter, faster, brighter, ~1.0 s
fn append_pattern(sink: &Sink, priority: Priority) {
    match priority {
        Priority::Low => {
            sink.append(tone(880.0, 180, 0.22));
            sink.append(tone(660.0, 220, 0.18));
        }
        Priority::Normal => {
            for _ in 0..2 {
                sink.append(tone(540.0, 220, 0.32));
                sink.append(tone(880.0, 220, 0.32));
            }
        }
        Priority::High => {
            for _ in 0..4 {
                sink.append(tone(880.0, 120, 0.42));
                sink.append(tone(1100.0, 120, 0.42));
            }
        }
    }
}

fn tone(freq: f32, ms: u64, amp: f32) -> impl Source<Item = f32> + Send + 'static {
    SineWave::new(freq)
        .take_duration(Duration::from_millis(ms))
        .amplify(amp)
}
