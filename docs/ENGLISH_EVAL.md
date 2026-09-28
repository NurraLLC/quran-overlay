# English navigation and search evaluation

Generated 2026-09-28T12:35:27.175Z by `npm run eval:english` over `fixtures/english-requests.json` (50 requests). Local routes only: exact references, chapter aliases, numerals, next/previous, lexical retrieval. No JEV call was made (no key configured); "in JEV shortlist" means the expected ayah would be among the passages offered to JEV. Expected keys for meaning queries are illustrative, not exhaustive relevance labels.

- Dev split: 21/22 pass. Held-out test split: 28/28 pass.
- Meaning search candidate recall (26 queries): lexical top-5 24, lexical top-30 25, semantic not set up, fused top-24 (JEV shortlist) 25.
- Ordinary speech/commentary that caused navigation: 0.

| Split | Request | Expected | Result | Detail | Local ms |
|---|---|---|---|---|---|
| dev | 2:255 | navigate 2:255 | pass | 2:255 | 0.5 |
| dev | surah two verse two hundred fifty five | navigate 2:255 | pass | 2:255 | 0.2 |
| dev | Surah Maryam ayah 3 | navigate 19:3 | pass | 19:3 | 0.9 |
| dev | go to surah yaseen | navigate 36:1 | pass | 36:1 | 0.4 |
| dev | al kahf verse ten | navigate 18:10 | pass | 18:10 | 1.5 |
| dev | chapter one hundred twelve | navigate 112:1 | pass | 112:1 | 0.2 |
| test | surah rahman verse thirteen | navigate 55:13 | pass | 55:13 | 0.8 |
| dev | ayah 5 | navigate 18:5 | pass | 18:5 | 0.0 |
| dev | next | navigate 2:256 | pass | 2:256 | 0.0 |
| test | previous one | navigate 2:254 | pass | 2:254 | 0.0 |
| test | ayatul kursi | navigate 2:255 | pass | 2:255 | 0.0 |
| test | baqarah two eight two | navigate 2:282 | pass | 2:282 | 1.3 |
| test | take me to surah al mulk | navigate 67:1 | pass | 67:1 | 0.3 |
| test | show surah ikhlas | navigate 112:1 | pass | 112:1 | 0.3 |
| test | surah an nas ayah six | navigate 114:6 | pass | 114:6 | 0.3 |
| dev | surah 115 | invalid_reference | pass | There is no surah 115. Surahs are numbered 1 to 114. | 0.0 |
| dev | surah fatiha verse 9 | invalid_reference | pass | Surah Al-Fatihah (1) has 7 ayahs; 9 is out of range. | 0.3 |
| test | ayah 300 | invalid_reference | pass | Surah Al-Baqarah (2) has 286 ayahs; 300 is out of range. | 0.0 |
| test | surah al kahf verse one hundred twenty | invalid_reference | pass | Surah Al-Kahf (18) has 110 ayahs; 120 is out of range. | 0.5 |
| dev | no soul is burdened beyond its capacity | candidates (2:286) | pass | lexical rank 5; in JEV shortlist (top 24): yes | 0.8 |
| dev | God does not burden a soul more than it can bear | candidates (2:286) | pass | lexical rank 4; in JEV shortlist (top 24): yes | 1.9 |
| dev | God will not give me more than I can handle | candidates (2:286) | pass | lexical rank 2; in JEV shortlist (top 24): yes — paraphrase; research BM25 rank 504 | 1.5 |
| dev | every soul will taste death | candidates (3:185, 21:35, 29:57) | pass | lexical rank 1; in JEV shortlist (top 24): yes | 0.3 |
| dev | everybody eventually passes away | candidates (3:185, 21:35, 29:57, 55:26) | pass | lexical rank 15; in JEV shortlist (top 24): yes — paraphrase | 0.1 |
| dev | be kind to mom and dad | candidates (17:23, 4:36, 6:151, 29:8, 31:14, 46:15, 2:83) | **fail** | lexical rank 84; in JEV shortlist (top 24): no — paraphrase; research BM25 rank 825 | 0.2 |
| dev | do not say uff to your parents | candidates (17:23) | pass | lexical rank 1; in JEV shortlist (top 24): yes | 0.7 |
| dev | with hardship comes ease | candidates (94:5, 94:6) | pass | lexical rank 1; in JEV shortlist (top 24): yes | 0.1 |
| dev | call upon me and I will respond to you | candidates (40:60, 2:186) | pass | lexical rank 3; in JEV shortlist (top 24): yes | 0.1 |
| dev | there is no compulsion in religion | candidates (2:256) | pass | lexical rank 1; in JEV shortlist (top 24): yes | 0.2 |
| test | whoever saves one life it is as if he saved all of mankind | candidates (5:32) | pass | lexical rank 1; in JEV shortlist (top 24): yes | 0.3 |
| test | we made you into nations and tribes so that you may know one another | candidates (49:13) | pass | lexical rank 1; in JEV shortlist (top 24): yes | 0.3 |
| test | Allah is the light of the heavens and the earth | candidates (24:35) | pass | lexical rank 2; in JEV shortlist (top 24): yes | 1.2 |
| test | remember me and I will remember you | candidates (2:152) | pass | lexical rank 1; in JEV shortlist (top 24): yes | 0.1 |
| test | hearts find rest in the remembrance of Allah | candidates (13:28) | pass | lexical rank 1; in JEV shortlist (top 24): yes | 0.5 |
| test | Allah will not change a people until they change what is in themselves | candidates (13:11) | pass | lexical rank 2; in JEV shortlist (top 24): yes | 0.9 |
| test | do not despair of the mercy of Allah | candidates (39:53) | pass | lexical rank 4; in JEV shortlist (top 24): yes | 1.1 |
| test | seek help through patience and prayer | candidates (2:45, 2:153) | pass | lexical rank 1; in JEV shortlist (top 24): yes | 0.1 |
| test | Moses sees a fire and goes to it | candidates (20:10, 27:7, 28:29) | pass | lexical rank 4; in JEV shortlist (top 24): yes — story paraphrase | 0.2 |
| test | Joseph dreams of eleven stars and the sun and moon | candidates (12:4) | pass | lexical rank 1; in JEV shortlist (top 24): yes | 0.1 |
| test | Mary and the trunk of the palm tree | candidates (19:23, 19:25) | pass | lexical rank 2; in JEV shortlist (top 24): yes | 0.0 |
| test | the youths who took refuge in the cave | candidates (18:10, 18:9, 18:13) | pass | lexical rank 1; in JEV shortlist (top 24): yes | 0.1 |
| test | my Lord increase me in knowledge | candidates (20:114) | pass | lexical rank 1; in JEV shortlist (top 24): yes | 0.3 |
| test | the night of decree is better than a thousand months | candidates (97:3) | pass | lexical rank 1; in JEV shortlist (top 24): yes | 0.1 |
| test | fasting has been prescribed for you as it was for those before you | candidates (2:183) | pass | lexical rank 1; in JEV shortlist (top 24): yes | 0.1 |
| test | Jonah swallowed by the fish | candidates (37:142, 21:87, 68:48) | pass | lexical rank 1; in JEV shortlist (top 24): yes — paraphrase | 0.0 |
| dev | okay everyone thanks for joining the stream tonight | not_navigate | pass | candidates | 0.1 |
| dev | let me get a glass of water | not_navigate | pass | candidates | 0.1 |
| test | can you all hear me okay | not_navigate | pass | candidates | 0.2 |
| test | next time we will continue from here | not_navigate | pass | candidates | 0.1 |
| test | please like and subscribe | not_navigate | pass | candidates | 0.7 |
