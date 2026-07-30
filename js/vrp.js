import { randomSpot, clampToViewport } from './position-utils.js';
import { setShootWordVisible } from './shoot.js';
import { setClockVisible } from './clock.js';

const IMPRESSUM_BODY = `Angaben gemäß § 5 TMG / § 18 Abs. 2 MStV

[Name / Vorname]
[Straße, Hausnummer]
[PLZ, Ort]

Kontakt:
E-Mail: [deine@email.adresse]

Verantwortlich für den Inhalt:
[Name]

Hinweis: Dies ist ein Platzhalter-Entwurf. Bitte vor Veröffentlichung
die eigenen Daten eintragen und im Zweifel rechtlich prüfen lassen.`;

const DATENSCHUTZ_BODY = `Datenschutzerklärung (Entwurf)

1. Verantwortlicher
[Name, Anschrift, E-Mail] ist verantwortlich für die Datenverarbeitung
auf dieser Website.

2. Welche Daten werden verarbeitet
– Beim Anlegen eines Kontos: Collection name, E-Mail-Adresse, Passwort
  (verschlüsselt gespeichert, wir selbst haben keinen Zugriff darauf)
– Beim Pushen: das hochgeladene Bild, eingegebene Tags, technische
  Bildmaße
– Kommentare, die du verfasst
– Wem du folgst (einseitig, nicht umgekehrt sichtbar)
– Freiwillig: Newsletter-Einwilligung

Bilder und Kommentare werden bewusst anonym behandelt und nicht in der
Datenbank mit deinem Konto sichtbar verknüpft.

3. Zweck der Verarbeitung
Betrieb der Plattform, Kontoverwaltung, Anzeige der von dir gepushten/
gepullten Inhalte, Versand des Newsletters (nur bei Einwilligung).

4. Hosting
Diese Seite nutzt Supabase (Datenbank, Authentifizierung, Speicher) als
Auftragsverarbeiter. Der Serverstandort hängt von der gewählten
Supabase-Region ab. [Region hier ergänzen]

5. Speicherdauer
Deine Konto-Daten bleiben gespeichert, bis du dein Konto löschst.
Gepushte Bilder und Kommentare sind bewusst dauerhaft und können auch
nach Löschung deines Kontos bestehen bleiben, da sie nicht an dein
Konto gekoppelt sind.

6. Deine Rechte
Du hast das Recht auf Auskunft, Berichtigung, Löschung und Widerspruch
bezüglich deiner personenbezogenen Daten, sowie das Recht auf Beschwerde
bei einer Datenschutz-Aufsichtsbehörde. Dein Konto kannst du jederzeit
selbst über "edit data" löschen.

7. Cookies / lokale Speicherung
Zur Anmeldung wird eine technisch notwendige Sitzungsinformation lokal
in deinem Browser gespeichert (kein Tracking, kein Marketing-Cookie).

Hinweis: Dies ist ein Platzhalter-Entwurf, keine Rechtsberatung.`;

const HAFTUNG_BODY = `Haftungsausschluss (Entwurf)

Inhalte der Nutzer:innen
Bilder, Tags und Kommentare auf dieser Seite werden von Nutzer:innen
selbst hochgeladen. Wir prüfen die Inhalte nicht vor der Veröffentlichung
und übernehmen keine Verantwortung für ihre Richtigkeit, Rechtmäßigkeit
oder Herkunft. Nutzer:innen sind für die von ihnen hochgeladenen Inhalte
selbst verantwortlich, insbesondere für die Einhaltung von
Urheberrechten.

Werden uns Rechtsverletzungen bekannt, entfernen wir die betroffenen
Inhalte umgehend (Meldefunktion "report"). Eine Vorabprüfung findet
aus konzeptionellen Gründen nicht statt.

Haftung für Links
Sollte diese Seite auf externe Inhalte verlinken, machen wir uns diese
nicht zu eigen und übernehmen keine Haftung für deren Inhalt.

Hinweis: Dies ist ein Platzhalter-Entwurf, keine Rechtsberatung.`;

// ─────────────────────────────────────────────
// Journals und Essays — hier später echte Einträge ergänzen.
// Journal-Titel: "j01_name", "j02_name", ...
// Essay-Titel:   "e_name_by_autor"
// ─────────────────────────────────────────────
const JOURNALS = [
  { title: 'j01_beispiel', body: '(Platzhalter — hier kommt dein erster Journal-Eintrag hin)' },
];

const ESSAYS = [
  { title: 'e_beispiel_by_dein_name', body: '(Platzhalter — hier kommt dein erster Essay hin)' },
];

const INFO_NODE = {
  title: 'info',
  children: [
    { title: 'impressum', body: IMPRESSUM_BODY },
    { title: 'datenschutz', body: DATENSCHUTZ_BODY },
    { title: 'haftung', body: HAFTUNG_BODY },
  ],
};

const ABOUT_NODE = { title: 'visual research project', body: '' };

function topLevelTopics() {
  return [
    ABOUT_NODE,
    INFO_NODE,
    ...JOURNALS.map((j) => ({ ...j, category: 'journal' })),
    ...ESSAYS.map((e) => ({ ...e, category: 'essay' })),
  ];
}

export function initVrp(refs) {
  const { overlay, listLayer, textLayer, escBtn } = refs;

  let filterMode = 'all'; // 'all' | 'journal' | 'essay'
  let stack = []; // Inhalte, die über den obersten Listen-Level hinaus geöffnet wurden

  function clearListLayer() {
    listLayer.innerHTML = '';
  }

  function addWord(text, onClick) {
    const el = document.createElement('div');
    el.className = 'menu-word';
    el.textContent = text;
    el.style.cursor = 'pointer';
    if (onClick) el.addEventListener('click', onClick);
    listLayer.appendChild(el);
    return el;
  }

  function scatterCurrentWords() {
    const taken = [];
    const words = [...listLayer.children, escBtn];
    words.forEach((el) => {
      const spot = randomSpot(taken, { margin: 60, minDist: 130 });
      taken.push(spot);
      el.style.left = spot.x + 'px';
      el.style.top = spot.y + 'px';
      clampToViewport(el);
    });
  }

  function openContent(node) {
    stack.push(node);
    render();
  }

  function setFilter(mode) {
    filterMode = mode;
    stack = [];
    render();
  }

  function render() {
    clearListLayer();

    const top = stack[stack.length - 1];

    if (top) {
      if (top.children) {
        textLayer.style.display = 'none';
        listLayer.style.display = 'block';
        top.children.forEach((child) => {
          addWord(child.title, () => openContent(child));
        });
        scatterCurrentWords();
      } else {
        listLayer.style.display = 'none';
        textLayer.style.display = 'block';
        textLayer.textContent = top.body || '(noch kein Text — folgt)';
      }
      return;
    }

    // Oberste Ebene: entweder alle Themen, oder nach Journal/Essay gefiltert
    textLayer.style.display = 'none';
    listLayer.style.display = 'block';

    if (filterMode === 'all') {
      addWord('j', () => setFilter('journal'));
      addWord('e', () => setFilter('essay'));
      topLevelTopics().forEach((topic) => {
        addWord(topic.title, () => openContent(topic));
      });
    } else if (filterMode === 'journal') {
      JOURNALS.forEach((j) => addWord(j.title, () => openContent({ ...j, category: 'journal' })));
    } else if (filterMode === 'essay') {
      ESSAYS.forEach((e) => addWord(e.title, () => openContent({ ...e, category: 'essay' })));
    }

    scatterCurrentWords();
  }

  function open() {
    filterMode = 'all';
    stack = [];
    overlay.style.display = 'block';
    setShootWordVisible(false);
    setClockVisible(false);
    render();
  }

  function close() {
    overlay.style.display = 'none';
    setShootWordVisible(true);
    setClockVisible(true);
  }

  escBtn.addEventListener('click', () => {
    if (stack.length > 0) {
      stack.pop();
      render();
    } else if (filterMode !== 'all') {
      filterMode = 'all';
      render();
    } else {
      close();
    }
  });

  return {
    open,
    close,
    filterJournal: () => setFilter('journal'),
    filterEssay: () => setFilter('essay'),
    // Für Fenstergrößenänderungen: aktuell sichtbare Wörter neu anordnen.
    reposition: () => {
      if (overlay.style.display === 'block') scatterCurrentWords();
    },
  };
}
