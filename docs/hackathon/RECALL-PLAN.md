# Recall: locked idea (Tyler, Nov 8 evening)

Live talk captions, plain-language mode, and hybrid search over everything said. Tracks: Elasticsearch (core), Merge Forward (accessibility). Gitar, Dash0, Radar via process. Not yet approved with Owen: confirm tonight.

NOTES ONLY. No scaffold or code before kickoff (rule). Build starts 11 AM Nov 9.

## Contract (agree with Owen, build against fake data until real pipeline works)
Transcript chunk JSON: {talk_id, speaker, start_s, end_s, text, plain_text, lang}
ES index `recall-chunks`: text (BM25), plain_text, embedding (dense_vector), talk_id, start_s.
API: GET /search?q= (hybrid, returns chunk + talk + timestamp), GET /talks/{id}/stream (SSE live captions).

## Split
- Owen: audio -> chunks -> JSON. Local Whisper-class ASR + small LLM for plain_text on 3090s. Fallback to hosted API if local not working by 12:30 PM.
- Tyler: ES index + hybrid search API, web UI (live captions, plain toggle, search, jump to time), Gitar rules, OTel -> Dash0, deploy to Radar cluster, DEMO.md.

## Timeline
- 9:00 check-in, get Radar join code, ask where the submission portal is
- 11:00 repo skeleton + contract + fake data
- 12:30 real ASR feeding ES
- 3:00 thin end-to-end path demoable
- 4:30 feature freeze, README + AI-use disclosure, demo recording
- 5:30 submit

## Process evidence (collect as you go, screenshot each)
- Gitar: .gitar rules file, every change via PR, one CI failure fixed by Gitar
- Dash0: traces on search + ingest, browser RUM, one real Agent0/MCP diagnosis
- Radar: app on cluster, one real investigation + decision
- Elastic: Cloud trial if docker.elastic.co is still denied

## Tonight
- Tyler: finish WeMakeDevs profile (country, DOB, job title)
- Both: team name slug (<=20 chars, lowercase/digits/dashes), Owen's Radar email
- Test Owen's 3090 box with COMPUTE.md smoke calls
- Decide: Elastic Cloud trial yes/no
