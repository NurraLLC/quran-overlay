# English navigation and search evaluation

Generated 2026-09-28T13:50:23.450Z by `npm run eval:english -- --set fixtures/english-requests-v2.json` (41 requests). Local routes only: exact references, chapter aliases, numerals, next/previous, translation-wording + meaning retrieval. JEV (live, OpenRouter Decisions) selected among the retrieved passages; the first card reflects its choice when it made one;  "in JEV shortlist" means the expected ayah would be among the passages offered to JEV. Expected keys for meaning queries are illustrative, not exhaustive relevance labels.

- 36/41 pass.
- First card is an expected passage: 26/30. First card is a listed wrong-context passage: 0.
- Meaning search candidate recall (30 queries): lexical top-5 22, lexical top-30 27, semantic top-30 26, fused top-5 (cards shown without JEV) 22, fused top-24 (JEV shortlist) 27.
- Meaning-search time on this machine (local retrieval incl. query embedding): p50 238.6 ms, p95 970.2 ms; model load + warm-up 362 ms at startup.
- Ordinary speech/commentary that caused navigation: 0.

| Split | Request | Expected | Result | Detail | Local ms |
|---|---|---|---|---|---|
| all | Nuh builds the ship | candidates (11:37, 11:38, 23:27, 54:13) | pass | lexical rank 20, semantic rank 3; shown cards (top 5): no; JEV shortlist (top 24): yes | 363.0 |
| all | the flood of Noah | candidates (11:40, 11:44, 29:14, 54:11, 54:12) | pass | lexical rank 2, semantic rank 2; shown cards (top 5): yes (#2); JEV shortlist (top 24): yes | 223.7 |
| all | Ibrahim and the birds cut into pieces | candidates (2:260) | pass | lexical rank 29, semantic rank 2; shown cards (top 5): no; JEV shortlist (top 24): yes | 950.3 |
| all | Isa speaks from the cradle | candidates (19:29, 19:30, 3:46) | pass | lexical rank 1, semantic rank 1; shown cards (top 5): yes (#1); JEV shortlist (top 24): yes | 203.5 |
| all | Sulayman and the ants | candidates (27:18, 27:19) | pass | lexical rank 1, semantic rank 1; shown cards (top 5): yes (#1); JEV shortlist (top 24): yes | 970.2 |
| all | Dawud's armour of iron | candidates (21:80, 34:10, 34:11) | pass | lexical rank 5, semantic rank 8; shown cards (top 5): no; JEV shortlist (top 24): yes | 238.6 |
| all | Yunus prays in the darkness | candidates (21:87, 21:88) | pass | lexical rank 13, semantic rank >30; shown cards (top 5): no; JEV shortlist (top 24): yes | 975.3 |
| all | Musa strikes the sea with his staff | candidates (26:63) | pass | lexical rank 1, semantic rank 1; shown cards (top 5): yes (#1); JEV shortlist (top 24): yes | 238.6 |
| all | the sacrifice of Ibrahim's son | candidates (37:102, 37:103, 37:107) | pass | lexical rank 1, semantic rank 4; shown cards (top 5): yes (#1); JEV shortlist (top 24): yes | 960.0 |
| all | Lut's people and their destruction | candidates (11:82, 15:73, 15:74, 26:173) | **fail** | lexical rank >6236, semantic rank >30; shown cards (top 5): no; JEV shortlist (top 24): no | 219.0 |
| all | honour your mother and father | candidates (17:23, 17:24, 4:36, 6:151, 31:14, 46:15, 29:8, 2:83) | pass | lexical rank 3, semantic rank 1; shown cards (top 5): yes (#2); JEV shortlist (top 24): yes — 80:35 mentions mother and father but is about fleeing on the Day of Judgment | 928.2 |
| all | pray for your parents' mercy | candidates (17:24, 71:28, 14:41) | pass | lexical rank 16, semantic rank 9; shown cards (top 5): yes (#5); JEV shortlist (top 24): yes | 276.9 |
| all | a man flees from his own brother on that day | candidates (80:34, 80:35, 80:36) | pass | lexical rank 1, semantic rank 1; shown cards (top 5): yes (#1); JEV shortlist (top 24): yes | 916.0 |
| all | mother carried him in weakness upon weakness | candidates (31:14, 46:15) | pass | lexical rank 1, semantic rank 1; shown cards (top 5): yes (#1); JEV shortlist (top 24): yes | 222.6 |
| all | we will test you with fear and hunger and loss of wealth | candidates (2:155) | pass | lexical rank 1, semantic rank 1; shown cards (top 5): yes (#1); JEV shortlist (top 24): yes | 928.8 |
| all | Allah is with the patient | candidates (2:153, 8:46, 2:249, 8:66) | pass | lexical rank 2, semantic rank 2; shown cards (top 5): yes (#3); JEV shortlist (top 24): yes | 211.8 |
| all | be patient with beautiful patience | candidates (70:5, 12:18, 12:83) | pass | lexical rank 1, semantic rank 1; shown cards (top 5): yes (#1); JEV shortlist (top 24): yes | 226.3 |
| all | no disaster strikes except by Allah's permission | candidates (64:11, 57:22) | pass | lexical rank 1, semantic rank 1; shown cards (top 5): yes (#1); JEV shortlist (top 24): yes | 220.9 |
| all | don't mock other people | candidates (49:11) | pass | lexical rank 42, semantic rank 12; shown cards (top 5): no; JEV shortlist (top 24): yes | 185.7 |
| all | don't spy or backbite | candidates (49:12) | pass | lexical rank 1, semantic rank 26; shown cards (top 5): yes (#1); JEV shortlist (top 24): yes | 238.7 |
| all | give full measure and weight | candidates (17:35, 6:152, 11:85, 26:181, 83:1) | pass | lexical rank 2, semantic rank 1; shown cards (top 5): yes (#2); JEV shortlist (top 24): yes | 194.6 |
| all | do not waste, Allah does not love the wasteful | candidates (7:31, 6:141, 17:26, 17:27) | pass | lexical rank 3, semantic rank 1; shown cards (top 5): yes (#2); JEV shortlist (top 24): yes | 227.3 |
| all | repel evil with what is better | candidates (41:34, 23:96, 13:22, 28:54) | pass | lexical rank 1, semantic rank 1; shown cards (top 5): yes (#1); JEV shortlist (top 24): yes | 206.3 |
| all | the best provision is taqwa | candidates (2:197) | **fail** | lexical rank 14, semantic rank >30; shown cards (top 5): no; JEV shortlist (top 24): no | 235.8 |
| all | orphans' property | candidates (4:10, 4:2, 6:152, 17:34) | pass | lexical rank 2, semantic rank 1; shown cards (top 5): yes (#2); JEV shortlist (top 24): yes | 221.9 |
| all | speak kindly to people | candidates (2:83, 17:53, 20:44) | **fail** | lexical rank 34, semantic rank >30; shown cards (top 5): no; JEV shortlist (top 24): no | 288.1 |
| all | the believers are brothers | candidates (49:10) | pass | lexical rank 1, semantic rank 1; shown cards (top 5): yes (#1); JEV shortlist (top 24): yes | 277.0 |
| all | Allah does not burden a soul beyond its ability | candidates (2:286, 2:233, 6:152, 7:42, 23:62, 65:7) | pass | lexical rank 1, semantic rank 1; shown cards (top 5): yes (#1); JEV shortlist (top 24): yes | 218.3 |
| all | paradise under which rivers flow | candidates (2:25, 3:15, 3:136, 4:13, 9:72, 9:100) | pass | lexical rank 1, semantic rank 4; shown cards (top 5): yes (#1); JEV shortlist (top 24): yes — many correct answers | 299.2 |
| all | the day when every soul will find what it did of good | candidates (3:30) | pass | lexical rank 1, semantic rank 1; shown cards (top 5): yes (#1); JEV shortlist (top 24): yes | 264.9 |
| all | juz thirty | navigate 78:1 | **fail** | invalid_reference | 0.0 |
| all | para one | navigate 1:1 | **fail** | invalid_reference | 0.0 |
| all | surah waqiah verse one | navigate 56:1 | pass | 56:1 | 0.3 |
| all | ayah seven | navigate 36:7 | pass | 36:7 | 0.0 |
| all | surah al baqarah two hundred and eighty six | navigate 2:286 | pass | 2:286 | 0.3 |
| all | go to surah ar rahman | navigate 55:1 | pass | 55:1 | 0.3 |
| all | juz thirty one | invalid_reference | pass | There are 30 juzs; 31 is out of range. | 0.0 |
| all | surah yusuf verse one hundred twelve | invalid_reference | pass | Surah Yusuf (12) has 111 ayahs; 112 is out of range. | 0.3 |
| all | hold on I need to adjust the camera | not_navigate | pass | candidates | 232.3 |
| all | salam everyone welcome back | not_navigate | pass | candidates | 244.9 |
| all | let us begin shall we | not_navigate | pass | candidates | 569.2 |
