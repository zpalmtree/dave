# Video pronunciation

The desktop renderer voices `oalgo`, `Oalgo`, and `OALGO` in dialogue as the
Spanish phrase “o algo.” This pronunciation alias is separate from chat acronym
expansion (`WTF` → “what the fuck”). Ordinary initialisms such as `FBI`, `CEO`,
and `GG` retain their existing handling.

The alias only changes the words passed to H3 and LTX for speech. Saved
`dialogue.text`, speaker IDs, and requested visible text retain their original
spelling. A planner-supplied `spoken_text` cannot expand `OALGO` into individual
letters or an unrelated phrase. OALGO command guidance also states its Spanish
pronunciation. LTX enhancement checks the rendered words so it cannot silently
restore the unexpanded spelling while rewriting a draft.

In job `af25b0aa`, the saved render plan contained `OALGO` as a speaker label and
in scene instructions, but not in its dialogue. Its second segment had no
dialogue entries despite visual directions implying continued speech. This
points to instruction leakage rather than an acronym replacement inserting the
name. Both compilers now explicitly exclude metadata from speech and mark shots
without dialogue as containing no speech. These prompt constraints reduce that
risk; they do not guarantee a generative model's output.

## Desktop change and verification

`desktop/video-oalgo-pronunciation.patch` records the change against the live
desktop baseline, which already contained the pending acronym and `spoken_text`
implementation. `desktop/video-oalgo-pronunciation-hashes.json` records exact
before/after file hashes. It does not bundle those pre-existing changes.

The patch has already been applied to
`D:\AI\ComfyUI_windows_portable\video_gen`. New generator subprocesses load it
automatically; a worker restart is unnecessary. To apply it to another matching
baseline, check the recorded hashes and run `git apply --check` before applying
the patch. An absent before hash denotes a new file.

Run the CPU-only regression checks in that directory:

```sh
python3 -m unittest test_oalgo_pronunciation test_video_gen.CompilerTests -q
```

The checks cover phrase pronunciation, acronym preservation, rejected letter
expansions, both prompt compilers, unchanged saved/visible wording, and silent
reaction shots. All 39 desktop checks and 97 targeted Node tests passed, along
with the TypeScript build. No new video render or listening evaluation was
performed.
