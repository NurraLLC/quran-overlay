// "How and why": what the reader does, what it costs and where the money goes, the reward of
// helping (only well-graded sources, paraphrased in our own words, each linked to sunnah.com), and
// who makes it. The Quran ayah shown is fetched from the app's licensed text, never stored here.
import { useEffect, useState } from 'react';
import type { CreditView, SearchCard } from '../shared/contracts';
import { toQpcHafsEncoding } from '../shared/display-encoding';
import { NurraBadge } from './Nurra';
import { access, formatListening, type Access } from './net';

const REPO = 'https://github.com/NurraLLC/quran-overlay';

/** Hadith: the Arabic of the Prophet's words (classical text), our own English paraphrase, and the source. */
const NARRATIONS: Array<{ ar: string; en: string; ref: string; grade: string; url: string }> = [
  {
    ar: 'إِذَا مَاتَ الإِنْسَانُ انْقَطَعَ عَنْهُ عَمَلُهُ إِلاَّ مِنْ ثَلاَثَةٍ: إِلاَّ مِنْ صَدَقَةٍ جَارِيَةٍ، أَوْ عِلْمٍ يُنْتَفَعُ بِهِ، أَوْ وَلَدٍ صَالِحٍ يَدْعُو لَهُ',
    en: 'When a person dies, their deeds come to an end except three: ongoing charity (sadaqah jariyah), knowledge that people keep benefiting from, and a righteous child who prays for them.',
    ref: 'Sahih Muslim 1631',
    grade: 'sahih',
    url: 'https://sunnah.com/muslim:1631',
  },
  {
    ar: 'مَنْ دَلَّ عَلَى خَيْرٍ فَلَهُ مِثْلُ أَجْرِ فَاعِلِهِ',
    en: 'Whoever leads someone to a good deed has a reward like the one who does it.',
    ref: 'Sahih Muslim 1893',
    grade: 'sahih',
    url: 'https://sunnah.com/muslim:1893',
  },
  {
    ar: 'مَنْ قَرَأَ حَرْفًا مِنْ كِتَابِ اللَّهِ فَلَهُ بِهِ حَسَنَةٌ، وَالْحَسَنَةُ بِعَشْرِ أَمْثَالِهَا',
    en: 'Whoever recites a letter of the Book of Allah has a good deed for it, and a good deed is multiplied ten times.',
    ref: 'Jami` at-Tirmidhi 2910',
    grade: 'hasan',
    url: 'https://sunnah.com/tirmidhi:2910',
  },
  {
    ar: 'خَيْرُكُمْ مَنْ تَعَلَّمَ الْقُرْآنَ وَعَلَّمَهُ',
    en: 'The best of you are those who learn the Quran and teach it.',
    ref: 'Sahih al-Bukhari 5027',
    grade: 'sahih',
    url: 'https://sunnah.com/bukhari:5027',
  },
];

export function About() {
  const [me, setMe] = useState<Access | null>(null);
  const [ayah, setAyah] = useState<SearchCard | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    document.documentElement.dataset.surface = 'reader';
    document.title = 'How and why · Quran Reader';
    access()
      .then((a) => {
        setMe(a);
        return fetch('/api/verse/2:261', { credentials: 'same-origin' });
      })
      .then((r) => (r.ok ? r.json() : null))
      .then((c: SearchCard | null) => c && setAyah(c))
      .catch(() => undefined);
  }, []);

  const credits: CreditView | undefined = me?.credits;
  const donations = me?.billing?.donations ?? [];
  const donate = async (amountCents: number) => {
    setBusy(amountCents);
    setNote(null);
    const r = await fetch('/api/billing/donate', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ amountCents }) }).catch(() => null);
    const body = (await r?.json().catch(() => ({}))) as { url?: string; error?: string };
    if (body?.url) location.href = body.url;
    else {
      setBusy(null);
      setNote(body?.error ?? 'The payment page could not be opened. Please try again.');
    }
  };

  return (
    <div className="reader about">
      <header className="r-top">
        <a className="about-back" href="/">
          ‹ Quran Reader
        </a>
        <NurraBadge />
      </header>
      <main className="r-page about-page">
        <h1>How and why</h1>
        <p className="about-lead">
          Quran Reader follows your recitation: the ayah you are reciting appears as you recite it, each word with its meaning, on your phone or on a live stream. It is free to use, and it is made by Nurra.
        </p>

        <section>
          <h2>Why we made it</h2>
          <p>
            Reciting, from memory or reading along, is easier when the page keeps up with you. We wanted that for everyone: someone learning who needs to find their place, someone who wants the meaning of each word as they recite, a reciter sharing the Quran on a stream. No account, no ads, and no price in the way of opening the Quran.
          </p>
        </section>

        <section>
          <h2>How it works</h2>
          <ul>
            <li>It listens only while the microphone is on, and only while you speak: after a long pause nothing is sent. Your voice goes to our speech-recognition provider and nowhere else. We never record or keep your audio.</li>
            <li>The Arabic text and the translation are shown exactly as published (Quran.com; Saheeh International). Nothing about the Quran is generated.</li>
            <li>The code is open. Anyone can read it, check it, or run their own copy for free: <a href={REPO}>github.com/NurraLLC/quran-overlay</a>.</li>
          </ul>
        </section>

        <section>
          <h2>What it costs, and where the money goes</h2>
          <p>Reading, search and the stream overlay cost almost nothing to run. Live listening does: speech recognition costs about 12 cents for every hour a stream is open. So:</p>
          <ul>
            <li>Everyone gets free listening every month.</li>
            <li>Anyone who needs more can buy hours; the margin on those keeps listening free for others.</li>
            <li>
              Gifts go into a shared pool of <strong>sponsored listening</strong>. When someone’s free time runs out they keep reciting from it, up to an hour a day each, so no one can use it all up. A gift becomes listening at cost: 13 cents an hour covers the recognition and the payment fee.
            </li>
            <li>No ads, no selling data, no tracking.</li>
          </ul>
          {credits && credits.pool > 0 && <p className="about-pool">Right now {formatListening(credits.pool)} of sponsored listening is waiting for whoever needs it.</p>}
          {donations.length > 0 && (
            <div className="r-sponsor about-give">
              <h3>Sponsor listening for others</h3>
              <div className="r-packs">
                {donations.map((d) => (
                  <button key={d.amountCents} disabled={busy !== null} onClick={() => void donate(d.amountCents)}>
                    <span>{d.price}</span>
                    <strong>{busy === d.amountCents ? 'Opening…' : `about ${d.hours} h for others`}</strong>
                  </button>
                ))}
              </div>
              {note && <p className="r-note">{note}</p>}
            </div>
          )}
        </section>

        <section>
          <h2>The reward of helping</h2>
          <p>
            People often ask about the reward of supporting work like this. Reward is with Allah alone and we cannot promise it on His behalf; what matters is your intention. These are the texts that move us. The English is our own summary; each links to its source.
          </p>
          {ayah && (
            <figure className="about-text">
              <p className="about-ar about-quran" lang="ar" dir="rtl">{toQpcHafsEncoding(ayah.arabic)}</p>
              <figcaption>
                <p>{ayah.english}</p>
                <span className="about-ref">Quran, {ayah.surahName} {ayah.key} · Saheeh International</span>
              </figcaption>
            </figure>
          )}
          {NARRATIONS.map((n) => (
            <figure key={n.ref} className="about-text">
              <p className="about-ar" lang="ar" dir="rtl">{n.ar}</p>
              <figcaption>
                <p>{n.en}</p>
                <a className="about-ref" href={n.url} target="_blank" rel="noopener">
                  {n.ref} ({n.grade}) · sunnah.com
                </a>
              </figcaption>
            </figure>
          ))}
          <p className="about-fine">Grades are those shown on sunnah.com. We left out narrations graded weak, including a well-known one about leaving behind a copy of the Quran.</p>
        </section>

        <section>
          <h2>Who we are</h2>
          <p>
            Quran Reader is a project of <a href="https://nurra.org">Nurra</a>, which builds technology for Muslim communities. Questions, corrections or ideas are welcome on <a href={`${REPO}/issues`}>GitHub</a>.
          </p>
        </section>

        <footer className="r-brand">
          <NurraBadge />
          <a href="/">Open the reader</a>
        </footer>
      </main>
    </div>
  );
}
