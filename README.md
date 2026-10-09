# Kasha

Meeting notes for Windows. Kasha notices when a Teams, Slack, RingCentral or Zoom call starts and offers to transcribe it. It records on your PC without joining the call, transcribes locally, writes a summary with Claude, and saves the note to Obsidian.

## Using it

1. Download `Kasha-Setup-<version>.exe` from the [latest release](https://github.com/csprague96/kasha/releases/latest) and run it. It installs for your user only (no admin rights) and opens Kasha. Setup has three items:
   - **Speech models**: a one-time download of about 400 MB. Transcription and speaker separation run on your PC, so audio never leaves it.
   - **Summaries**: written by Claude Code or Codex using your existing sign-in, so no API key is needed. Sign in once with `claude` or `codex login`. **Automatic** (the default) uses Claude Code when it's signed in, otherwise Codex; you can pick one in Settings. Without either, you still get transcripts.
   - **Obsidian vault**: optional. Notes go to `Meetings/` in the vault.
2. Join a call as usual. When **Meeting detected** appears, select **Start transcribing**.
3. A bar stays at the top of the screen during the call:
   - **Note** adds a timestamped line to the note.
   - **Screenshot** opens the Windows snipping overlay; the image is added to the note.
   - **Stop** ends the recording. Kasha also stops on its own about 20 seconds after the call app releases the mic.
4. Kasha transcribes during the call, a minute or so behind, so the **Transcript** tab fills in as you talk. When the call ends it finishes the last few seconds and summarizes in the background. The note gets Summary, Decisions and Actions sections above your own notes, and then syncs to Obsidian.
5. You can record the next call while the last one is still being finished. The new call comes first: its live transcript runs ahead of the earlier note, which carries on more slowly (fewer threads, lowest priority) and says **slower during the call**. To leave the PC entirely to the call, select **Pause** on the earlier note, or the bar's pause button (it pauses both). A pause lasts until you resume or the recording ends. Pausing while speakers are being told apart stops that step; it starts over on resume.

Kasha updates itself: it checks the releases a few times a day, downloads a new version in the background, and the sidebar shows **Restart to update** when it's ready (it also installs on the next quit, but never while a call is being recorded or processed). The version is at the bottom of the sidebar; **Check for updates** is in Settings > General.

### Recording rules

Settings > Recording decides what happens when a call starts: **Ask each time** (a prompt in the corner), **Record every call**, or **Only the meetings and people under Always record**. The **Always record** lists are matched on the meeting title and, with the Outlook lookup on, the invite list; recording a recurring meeting offers to add it. The **Never record** list applies in every mode: those meetings are neither recorded nor asked about, and the call prompt has a **Never record this meeting** link that adds to it.

### Speech models

Settings > Transcription offers three models, all running on this PC: **Quick** (Parakeet 4-bit, the default), **Careful** (Parakeet 8-bit, a little more accurate, about 850 MB while running) and **Thorough** (Whisper medium.en: the most accurate on hard audio and jargon, the only one that takes Names and terms as spelling hints, several times slower, about 1 GB while running). Choosing a model downloads it; Kasha keeps using the one it has until the download finishes.

### Actions

**Actions** in the sidebar lists open checkboxes from every note, grouped by meeting. Your own come first and everyone else's are listed under **Others**, so you can follow up on them. Ticking an item updates the note and the Obsidian copy; the **×** on an item removes a checkbox that wasn't really an action, from the note and the Obsidian copy. Items ticked in Obsidian show as done in Kasha. Set **Your name** in Settings > Actions so actions assigned to you by name count as yours. On weekdays at 09:00 (configurable), a notification lists how many of your actions are open, due today or overdue.

Due dates are stored in the note as `(due 2026-10-06)`. Shared copies show them as "due Tue 6 Oct".

### Transcript

- **Speakers**: after the call, the people on the computer's audio are told apart as **Speaker 1**, **Speaker 2** and so on (your mic is always **You**). Select a name at the top of the transcript to rename it everywhere: the people Teams showed in the call and the people invited are offered with one click. Names Kasha worked out itself show as **Name?** with the reason on hover; select ✓ to confirm or × to turn it down. Until you confirm, a guessed name keeps its question mark in the summary, in Obsidian and in shared copies. Select the name on a line to move that line to someone else, or to **Someone else** for a new speaker. The summary uses the names after you select **Update summary**.
- **Names from Teams**: while a Teams call is recorded, Kasha reads the meeting window the way a screen reader does (Windows UI Automation): Teams labels each video tile with the person's name and whether they're muted. No captions, bots or calendar access are needed. In a one-to-one call the other voice is offered that person's name (**Name?**) to confirm: a tile can be a room system or miss a phone dial-in, so it is never taken as certain. In a group call, a voice that only talked while one person was unmuted is offered that name too. Everyone seen in the call shows in the Attendees tab as **In the call**, invitees the calendar listed only by email address are matched to those names, and your own address is matched to you. If you haven't set your name in Settings, Kasha takes it from your own Teams tile. The head count also caps how many voices a call can have, but only voices that sound alike are joined to fit it. What the reader sees is saved as it goes, so a crash doesn't lose it. The reader is a small C# program that Windows' built-in .NET compiler builds on first use (`%APPDATA%\Kasha\bin`); it runs only during Teams recordings, every 2 seconds at low priority (about 45 MB). Turn off **Name people from the Teams window** in Settings > Speakers to stop it.
- **Recognising people**: when you name or confirm a speaker, Kasha keeps that voice (a short list of numbers, not audio) in `voices.json` on your PC. Next time the voice is heard, the name is offered as **Name?**, but only when it clearly beats every other known voice (a score of 0.6 and a lead of 0.1), and only among the people in the call or invited when those are known. Kasha never learns a voice by itself, and never learns one it had to merge to fit the Teams head count. Settings > Speakers lists the learned voices, forgets one or all of them, and still shows them when recognition is off. Deleting a note deletes the voices learned from it.
- **Edit**: select a line to fix it. Enter saves and Esc cancels. When the edit changes one word, Kasha offers to remember the fix for future meetings.
- **Correct a word**: right-click a word in the transcript or the note, type how it should be spelled, and it's replaced throughout both. **Fix in future meetings too** (on by default) adds the pair to **Names and terms**.
- **Find and replace** (Ctrl+H): replaces whole words in the transcript and, optionally, the note. **Fix in future meetings too** adds the correction to **Names and terms**.

### Attendees

The **Attendees** tab lists who was at the meeting: the invite list (from Outlook when the attendee lookup is on, or people you add) against who was heard on the recording. Someone on the list who matches a named speaker shows as **Spoke** with their talking time; someone who doesn't is **Not heard**. People heard but not on the list are listed too, including unnamed speakers until you name them in the Transcript tab. A recording can't tell a silent attendee from a no-show, so hover a row to mark a person present or absent by hand, or to remove them from the list. The names go into the Obsidian note's front matter as `attendees` and `not_heard`, and onto the first line of shared copies.

### Names and terms

In Settings > Names and terms, list people's names and product terms, with what the speech model tends to hear instead (for example **RCVR**, heard as "Recover"). Kasha replaces the misheard forms in every new transcript (and, with a Whisper model, also gives the list to it as spelling hints). Replacement is whole-word and ignores case, so "recover" the verb is changed too. Leave the "heard as" part out for words that are only ever the name. The list is alphabetical, with a filter box and letter headings once it grows.

### Tags and finding notes

Each note has tags (the summary suggests one to three; add your own under the note, with existing tags offered as you type). Settings > Tags lists every tag in use: rename one to change it on every note, or remove it everywhere. Standing tags (say, `meeting`) go into every note Kasha writes to Obsidian, and the summary's topic tags can be turned off. In the sidebar, the calendar next to the search box marks the days that have notes; pick one to see just that day.

### Deleting a note

The trash button on a note asks before deleting. If the note was synced to Obsidian, it also asks whether to delete the Obsidian copy, which goes to the Recycle Bin along with the screenshots Kasha saved for it. Tick **Remember this decision** to stop being asked. You can change the choice later in Settings > Obsidian, under **When you delete a note in Kasha**.

### Share

**Share** on a note offers Copy, Email, Save as PDF and Save as Markdown, with a choice of summary and notes, transcript, or both. Summary only is the default. **Email** copies the formatted note and opens a new email with the subject filled in; paste the body with Ctrl+V. New Outlook can't open pre-filled drafts from a file, which is why the body is pasted.

You can also type notes in the main window during the call, paste or drop images into a note, or start a recording without a call from **New note**, then **Record**.

Tell people on the call when you're transcribing.

## How it works

| Part | Approach |
|---|---|
| Meeting detection | Polls the Windows mic-usage registry (`CapabilityAccessManager\ConsentStore\microphone`) every 3 s. Names the meeting from the call app's window title. |
| Audio | Mic and system audio (WASAPI loopback) are recorded as separate 16 kHz WAV tracks. In the transcript, the mic track is labelled **You** and the system audio **Others**, until you name them. |
| Transcription | NVIDIA **Parakeet TDT 0.6B v3** (4-bit), run by `parakeet-cli` from [whisper.cpp](https://github.com/ggml-org/whisper.cpp). Silero voice activity detection finds the speech in each track, which is packed into ~28-second chunks with short silences between the pieces. Parakeet's own word timings map every word back to when it was said, so lines from both tracks interleave in the right order. During a call a chunk is transcribed once about 20 seconds of speech has built up, on 4 threads at below-normal priority. One process runs at a time; a 28 s chunk takes about 4.6 s on a Core Ultra 7, peaks around 540 MB and exits (Whisper `small.en` took 18 s and 580 MB for the same chunk). With **Transcribe during the call** off, and on Retry, the same chunks run after the call on up to 6 threads. PCs that only have the older Whisper model keep using it until the new download runs. |
| Speakers | After the call, the system-audio track is split by voice with [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx): pyannote segmentation 3.0 finds the speech turns, each turn is cut into 2.5 s windows, and 3D-Speaker ERes2Net gives every window a voiceprint. Kasha groups the windows itself (average linkage, joining while the average similarity is at least 0.3; pyannote's own grouping was wrong on Teams audio), merges groups that are the same voice (0.4) and folds tiny ones in. It runs in a separate process (`speakers-worker.js`) that exits when done (about 300 MB while running, about 0.1x real time of the speech on 4 threads: a 60-minute call with 40 minutes of other people talking takes about 4 minutes. pyannote's 10 s window moves 5 s at a time (sherpa's default of 1 s did the same work about ten times over, three times slower, for the same voices)), and only the stretches with speech are analysed. On a real call, different people score 0.1-0.2 alike and the same person 0.7-0.8; CAM++, the model Kasha used first, ran two of three voices together. Each speaker's voiceprint is saved in `speakers.json` beside the transcript; naming a speaker files it under the name in `voices.json`, and later meetings name a voice that matches at 0.6 or above. |
| Summary | `claude -p` with no tools, no MCP and no project settings, or `codex exec` read-only with its shell tool and MCP servers off. Both use structured JSON output, and only transcript text is sent. If Claude Code isn't signed in, Automatic falls back to Codex. |
| Obsidian | Writes `{date} {title}.md` with YAML front matter; screenshots go to `attachments/`. A note that was edited in Obsidian since the last sync is not overwritten. |
| Storage | `%APPDATA%\Kasha\meetings\<id>\`: `meta.json`, `note.md`, `transcript.json`, `attachments/`. By default, audio is deleted after transcription; with **Keep audio** on it stays for 7 days, then goes. |
| Updates | [electron-updater](https://www.electron.build/auto-update) against this repo's GitHub releases. The Release workflow builds the installer on every push to `main` and publishes `v<version>` when `package.json` has a version with no release yet. |

### Compliance

- Card numbers (Luhn-checked, 13–19 digits), SSNs and card security codes are replaced with `[card number]`, `[SSN]` and `[security code]` in everything Kasha writes to disk: transcripts, typed notes, notes from the bar and summaries. They are caught however speech-to-text writes them: grouped with spaces, dashes, commas, periods, slashes or ellipses, with "and", "uh" or "okay" between groups, spoken as words ("four one one one", "double four"), or read in groups across several lines of the computer's audio within 10 seconds. A card, security code or SSN is also caught when it answers a question asked a moment before ("And the code on the back?"), a security code next to an expiry date or ZIP and an SSN next to a date of birth are told apart, and digits repeating a card heard in the last minute (a read-back) are redacted too. To keep notes intact, times, dates, decimals, versions and IP addresses are never read as part of a card, and a number only counts as a card if it starts like a real one (issuer ranges), passes the Luhn check and is grouped the way cards are read out (4-4-4-4, 4-6-5, digit by digit, or one unbroken number), unless a word like "card" or "Visa" comes right before it. On random samples, lists of times, dates, counts, amounts and phone numbers come through untouched, while lists of four-digit IDs are sometimes taken for a card (5-8%). Link targets, web addresses and attachment names are never changed. Text is redacted again where it leaves the app: the summary prompt, Obsidian and shared copies. `src/main/redact.test.ts` holds the cases, with test card numbers only.
- The summary prompt tells the model never to include card numbers, account numbers, SSNs or passwords.
- Codex use was approved by compliance. Use a company ChatGPT account for it, not a personal one.
- Audio stays on the device and is deleted once transcribed. With **Keep audio for 7 days** on, it stays on the PC for a week (each note shows when it goes, with **Save a copy** and **Delete now**) and is then deleted automatically.
- Learned voices are embeddings (192 numbers per meeting per person, tagged with the model that made them), not recordings, and never leave `%APPDATA%\Kasha\voices.json`. Each meeting's voiceprints (`speakers.json`) are kept only while recognition is on. They are biometric-like data: they're learned only when you name or confirm someone, deleted with the note they came from, and **Forget all voices** removes them all. Tell people on the call when you're transcribing, and turn **Recognise people from past meetings** off if your policy requires it.
- The speech binaries are pinned by SHA-256, and every model is verified against the hash its publisher lists.

### Memory use

- The GPU process is disabled, since the UI renders fine on the CPU.
- Closing the window destroys it; Kasha keeps running in the tray.
- The prompt and the recording bar are created only when needed and destroyed afterwards.
- Speech runs one chunk at a time at below-normal priority and exits after each, so no model stays loaded during the call. Speaker separation runs once per call in its own process and exits.
- When free memory drops under 1 GB during a call, live transcription waits (it starts again above 1.4 GB) and the bar says **transcribing waits for memory**. Select the play button to transcribe anyway; the recording carries on either way, and anything held back is transcribed after the call.
- An earlier note being finished during a call waits below the same line (**waiting for free memory**), so it doesn't add to the load on a PC that's short. Speaker separation (about 350 MB) isn't started while memory is low. **Carry on** on the note overrides it until the recording ends.

### When something goes wrong

- `%APPDATA%\Kasha\kasha.log` records events and counts only (no titles, names or text): calls detected, recordings started and stopped, memory every 5 minutes while recording, crashed windows and processes, and errors. Crash dumps stay in `%APPDATA%\Kasha\Crashpad`.
- Audio files stay valid while recording, so a crash loses at most the last few seconds. If Kasha restarts while the same call is still going (within 15 minutes), it carries on recording into the same note instead of asking again; otherwise the note offers **Retry**.
- Teams can let go of the microphone for a minute or more mid-call (muted, or switching devices). A Teams call only counts as over once its meeting window has no **Leave** button, so recording doesn't stop early or prompt again.
- If audio capture stops mid-call (a headset unplugged, Windows restarting its audio, or no audio arriving for 15 seconds), the bar restarts it and fills the gap with silence so times still line up. If it keeps stopping, Kasha ends the recording and says so. Each track is lined up with the recording clock when its first audio arrives, so "Others" lines and the Teams timeline line up with "You".
- One chunk that fails to transcribe during a call is retried, then tried once more after the call; it no longer stops live transcription. If the summary can't be written (Claude signed out, a network error), the note is still saved and synced with the transcript, and says to select **Update summary**.
- While a call is being recorded, finishing the previous meeting uses fewer threads, so the call comes first.
- Opening Kasha while it is already running just shows the running copy.
- If the PC goes to sleep during a recording, the recording ends there (the call drops too), rather than filling the sleep with silence.

## Development

```bash
npm install
npm run dev        # hot reload
npm run build      # production build to out/
npm test           # unit tests (vitest); CI and the Release workflow run them too
npm run dist       # Windows installer to dist/
npm run icons      # regenerate icons from the logo
```

To ship an update, bump `version` in `package.json` and merge to `main`: the Release workflow builds and publishes it, and installed copies pick it up. `KASHA_FAKE_UPDATE="ready 0.3.0"` shows the update UI from source.

`KASHA_NO_DETECT=1` turns off meeting detection, which is useful while testing during a real call. `KASHA_DATA_DIR=<folder>` keeps settings and notes in a separate folder so tests never touch real notes. `KASHA_TEST_SAVE_DIR=<folder>` saves PDF and Markdown exports there without a dialog.

Layout: `src/main` (Electron main process), `src/preload`, `src/renderer` (React + Tailwind; three pages: `index`, `toast`, `bar`), `src/shared` (types and the IPC contract).
