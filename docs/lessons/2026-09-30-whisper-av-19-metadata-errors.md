---
symptom: "TypeError: open() got an unexpected keyword argument 'metadata_errors' (the app shows \"Não foi possível decodificar o áudio\")"
tags: [whisper, transcription, docker, python, dependencies]
evidence: fixed
agent: claude
date: 2026-09-30
---
## Cause

`docker/whisper/Dockerfile` pinned `faster-whisper==1.2.1` but not its dependency `av` (PyAV). A
rebuild of the image picked up `av` 19.0.0, which removed the `metadata_errors` argument of
`av.open()`; faster-whisper 1.2.1 still passes it when it opens the audio. The container starts
healthy and loads the model, so nothing looks wrong until the first dictation: every transcription
then fails within a few milliseconds.

## Fix

Pin `av` next to faster-whisper (`av==18.1.0`; 16.1.0, 17.1.0 and 18.1.0 accept the argument, only
19.0.0 breaks). When bumping faster-whisper, re-check which `av` it supports and move both pins
together.

## How to check

`docker logs termhub-whisper-1` has no `transcription failed` line after a dictation, and the app
log shows `transcription started` followed by a result instead of `transcription failed` a few
milliseconds later. Inside the image:
`python -c "from faster_whisper.audio import decode_audio; decode_audio('<file>')"` returns samples.
