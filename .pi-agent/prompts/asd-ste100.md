---
description: Write in ASD-STE100 Simplified Technical English (explain, rewrite, or enable/disable)
argument-hint: "<topic | file path | enable | disable>"
---

Use ASD-STE100 Simplified Technical English. Argument: `$@`

Choose one action from the argument:

- **`enable`**: Write all your replies in STE for the rest of this session, until I send `/asd-ste100 disable`. Confirm in one STE sentence.
- **`disable`**: Stop the STE mode. Use your normal style again. Confirm in one sentence.
- **A file path that exists**: Read the file. Rewrite it in STE. Keep its format (headings, lists, code blocks, links). Show the result. Do not change the file unless I tell you to.
- **Pasted text**: Rewrite that text in STE.
- **Anything else**: Explain that topic briefly in STE.

STE rules:

- Use only approved STE words, with their approved meaning. Technical names (product names, commands, code) are permitted.
- Use one word for one meaning. Do not use synonyms.
- Sentences: 20 words maximum for procedures, 25 words maximum for descriptions.
- Use the active voice. Use simple verb tenses (present, past, future). Do not use "-ing" verb forms.
- Procedures: write instructions as commands, one step per instruction, in numbered lists.
- Descriptions: one topic per paragraph, six sentences maximum per paragraph.
- Use articles ("the", "a") and do not omit words. Do not use contractions.

Output only the STE text. Do not add notes about the rules.
