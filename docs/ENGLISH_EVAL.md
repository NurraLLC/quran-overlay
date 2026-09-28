# English navigation and search evaluation

Generated 2026-09-28T12:49:51.737Z by `npm run eval:english` over `fixtures/english-requests.json` (50 requests). Disclosure: the rule keeping each retriever's top hit in the fused list was added after a held-out query (5:32) exposed the problem, so the held-out split is not a clean measure of that rule. Local routes only: exact references, chapter aliases, numerals, next/previous, lexical + semantic retrieval. No JEV call was made (no key configured); "in JEV shortlist" means the expected ayah would be among the passages offered to JEV. Expected keys for meaning queries are illustrative, not exhaustive relevance labels.

- Dev split: 22/22 pass. Held-out test split: 28/28 pass.
- Meaning search candidate recall (26 queries): lexical top-5 24, lexical top-30 25, semantic top-30 24, fused top-5 (cards shown without JEV) 25, fused top-24 (JEV shortlist) 26.
- Meaning-search time on this machine (local retrieval incl. query embedding): p50 5.7 ms, p95 8.4 ms; model load + warm-up 349 ms at startup.
- Ordinary speech/commentary that caused navigation: 0.

| Split | Request | Expected | Result | Detail | Local ms |
|---|---|---|---|---|---|
| dev | 2:255 | navigate 2:255 | pass | 2:255 | 0.4 |
| dev | surah two verse two hundred fifty five | navigate 2:255 | pass | 2:255 | 0.1 |
| dev | Surah Maryam ayah 3 | navigate 19:3 | pass | 19:3 | 1.0 |
| dev | go to surah yaseen | navigate 36:1 | pass | 36:1 | 0.6 |
| dev | al kahf verse ten | navigate 18:10 | pass | 18:10 | 5.9 |
| dev | chapter one hundred twelve | navigate 112:1 | pass | 112:1 | 0.1 |
| test | surah rahman verse thirteen | navigate 55:13 | pass | 55:13 | 0.4 |
| dev | ayah 5 | navigate 18:5 | pass | 18:5 | 0.0 |
| dev | next | navigate 2:256 | pass | 2:256 | 0.0 |
| test | previous one | navigate 2:254 | pass | 2:254 | 0.0 |
| test | ayatul kursi | navigate 2:255 | pass | 2:255 | 0.0 |
| test | baqarah two eight two | navigate 2:282 | pass | 2:282 | 1.0 |
| test | take me to surah al mulk | navigate 67:1 | pass | 67:1 | 0.2 |
| test | show surah ikhlas | navigate 112:1 | pass | 112:1 | 0.3 |
| test | surah an nas ayah six | navigate 114:6 | pass | 114:6 | 0.3 |
| dev | surah 115 | invalid_reference | pass | There is no surah 115. Surahs are numbered 1 to 114. | 0.1 |
| dev | surah fatiha verse 9 | invalid_reference | pass | Surah Al-Fatihah (1) has 7 ayahs; 9 is out of range. | 0.3 |
| test | ayah 300 | invalid_reference | pass | Surah Al-Baqarah (2) has 286 ayahs; 300 is out of range. | 0.0 |
| test | surah al kahf verse one hundred twenty | invalid_reference | pass | Surah Al-Kahf (18) has 110 ayahs; 120 is out of range. | 0.2 |
| dev | no soul is burdened beyond its capacity | candidates (2:286) | pass | lexical rank 5, semantic rank 9; shown cards (top 5): no; JEV shortlist (top 24): yes | 8.4 |
| dev | God does not burden a soul more than it can bear | candidates (2:286) | pass | lexical rank 4, semantic rank 2; shown cards (top 5): yes (#2); JEV shortlist (top 24): yes | 8.4 |
| dev | God will not give me more than I can handle | candidates (2:286) | pass | lexical rank 2, semantic rank >30; shown cards (top 5): yes (#3); JEV shortlist (top 24): yes — paraphrase; research BM25 rank 504 | 8.5 |
| dev | every soul will taste death | candidates (3:185, 21:35, 29:57) | pass | lexical rank 1, semantic rank 1; shown cards (top 5): yes (#1); JEV shortlist (top 24): yes | 5.8 |
| dev | everybody eventually passes away | candidates (3:185, 21:35, 29:57, 55:26) | pass | lexical rank 15, semantic rank 3; shown cards (top 5): yes (#3); JEV shortlist (top 24): yes — paraphrase | 6.5 |
| dev | be kind to mom and dad | candidates (17:23, 4:36, 6:151, 29:8, 31:14, 46:15, 2:83) | pass | lexical rank 84, semantic rank 1; shown cards (top 5): yes (#2); JEV shortlist (top 24): yes — paraphrase; research BM25 rank 825 | 6.1 |
| dev | do not say uff to your parents | candidates (17:23) | pass | lexical rank 1, semantic rank 1; shown cards (top 5): yes (#1); JEV shortlist (top 24): yes | 5.9 |
| dev | with hardship comes ease | candidates (94:5, 94:6) | pass | lexical rank 1, semantic rank 1; shown cards (top 5): yes (#1); JEV shortlist (top 24): yes | 5.1 |
| dev | call upon me and I will respond to you | candidates (40:60, 2:186) | pass | lexical rank 3, semantic rank 29; shown cards (top 5): yes (#4); JEV shortlist (top 24): yes | 5.9 |
| dev | there is no compulsion in religion | candidates (2:256) | pass | lexical rank 1, semantic rank 2; shown cards (top 5): yes (#1); JEV shortlist (top 24): yes | 4.7 |
| test | whoever saves one life it is as if he saved all of mankind | candidates (5:32) | pass | lexical rank 1, semantic rank >30; shown cards (top 5): yes (#1); JEV shortlist (top 24): yes | 5.4 |
| test | we made you into nations and tribes so that you may know one another | candidates (49:13) | pass | lexical rank 1, semantic rank 1; shown cards (top 5): yes (#1); JEV shortlist (top 24): yes | 8.2 |
| test | Allah is the light of the heavens and the earth | candidates (24:35) | pass | lexical rank 2, semantic rank 1; shown cards (top 5): yes (#2); JEV shortlist (top 24): yes | 6.6 |
| test | remember me and I will remember you | candidates (2:152) | pass | lexical rank 1, semantic rank 1; shown cards (top 5): yes (#1); JEV shortlist (top 24): yes | 4.5 |
| test | hearts find rest in the remembrance of Allah | candidates (13:28) | pass | lexical rank 1, semantic rank 1; shown cards (top 5): yes (#1); JEV shortlist (top 24): yes | 5.7 |
| test | Allah will not change a people until they change what is in themselves | candidates (13:11) | pass | lexical rank 2, semantic rank 5; shown cards (top 5): yes (#3); JEV shortlist (top 24): yes | 5.6 |
| test | do not despair of the mercy of Allah | candidates (39:53) | pass | lexical rank 4, semantic rank 8; shown cards (top 5): yes (#3); JEV shortlist (top 24): yes | 5.2 |
| test | seek help through patience and prayer | candidates (2:45, 2:153) | pass | lexical rank 1, semantic rank 1; shown cards (top 5): yes (#1); JEV shortlist (top 24): yes | 4.5 |
| test | Moses sees a fire and goes to it | candidates (20:10, 27:7, 28:29) | pass | lexical rank 4, semantic rank 1; shown cards (top 5): yes (#2); JEV shortlist (top 24): yes — story paraphrase | 4.1 |
| test | Joseph dreams of eleven stars and the sun and moon | candidates (12:4) | pass | lexical rank 1, semantic rank 1; shown cards (top 5): yes (#1); JEV shortlist (top 24): yes | 4.1 |
| test | Mary and the trunk of the palm tree | candidates (19:23, 19:25) | pass | lexical rank 2, semantic rank 4; shown cards (top 5): yes (#3); JEV shortlist (top 24): yes | 4.1 |
| test | the youths who took refuge in the cave | candidates (18:10, 18:9, 18:13) | pass | lexical rank 1, semantic rank 1; shown cards (top 5): yes (#1); JEV shortlist (top 24): yes | 5.8 |
| test | my Lord increase me in knowledge | candidates (20:114) | pass | lexical rank 1, semantic rank 23; shown cards (top 5): yes (#1); JEV shortlist (top 24): yes | 4.8 |
| test | the night of decree is better than a thousand months | candidates (97:3) | pass | lexical rank 1, semantic rank 1; shown cards (top 5): yes (#1); JEV shortlist (top 24): yes | 4.3 |
| test | fasting has been prescribed for you as it was for those before you | candidates (2:183) | pass | lexical rank 1, semantic rank 2; shown cards (top 5): yes (#1); JEV shortlist (top 24): yes | 4.4 |
| test | Jonah swallowed by the fish | candidates (37:142, 21:87, 68:48) | pass | lexical rank 1, semantic rank 1; shown cards (top 5): yes (#1); JEV shortlist (top 24): yes — paraphrase | 5.8 |
| dev | okay everyone thanks for joining the stream tonight | not_navigate | pass | candidates | 5.4 |
| dev | let me get a glass of water | not_navigate | pass | candidates | 4.8 |
| test | can you all hear me okay | not_navigate | pass | candidates | 4.9 |
| test | next time we will continue from here | not_navigate | pass | candidates | 5.7 |
| test | please like and subscribe | not_navigate | pass | candidates | 6.3 |
