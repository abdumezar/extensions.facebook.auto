// Synthetic data for the screenshot harness.
//
// Everything here is invented: no real person, group, profile or number appears in it.
// Ids are runs of zeroes and phone numbers use the +20 100 000 xxxx pattern, so a
// shot that leaks into a README can never point at anyone.
//
// Plain JavaScript on purpose: the harness is a tool for contributors, not part of the
// extension, and it must stay out of the extension's own typecheck.

import { DEFAULT_FB_RECIPE, bundledDocIds } from "@nashir/shared";

const MINUTE = 60_000;

const TEXT = {
  ar: {
    name: "ليلى حداد",
    captions: [
      "عرض هذا الأسبوع: دفاتر ملاحظات بغلاف جلدي مصنوعة يدويًا بسعر خاص. للطلب راسلونا على الخاص.",
      "دفاتر يدوية بأغلفة جلدية بألوان متعددة، والتوصيل متاح داخل المدينة. اسألونا عن التفاصيل.",
    ],
    firstComment: "للتفاصيل والأسعار راسلونا على الخاص.",
    lastGroup: "سوق الكتب المستعملة",
    people: [
      ["منى السيد", "LOVE", "مهتمة بالدفاتر، أرسلوا لي التفاصيل على واتساب"],
      ["كريم نصار", "LIKE", "كم سعر الدفتر الكبير؟ رقمي للتواصل"],
      ["هدى المصري", "LIKE", ""],
      ["سامر خليل", "WOW", "هل يوجد توصيل إلى الإسكندرية؟ تواصلوا معي على الرقم"],
      ["رنا عبد الله", "LOVE", ""],
      ["طارق فؤاد", "LIKE", "أريد ثلاث نسخ، واتساب"],
      ["ياسمين درويش", "LIKE", ""],
      ["عمر شاهين", "HAHA", "تواصلوا معي لطلب كمية للمكتبة"],
      ["دينا حسني", "LOVE", ""],
      ["بسام الرفاعي", "LIKE", "مهتم، رقمي في التعليق"],
    ],
  },
  en: {
    name: "Layla Haddad",
    captions: [
      "This week's offer: hand-bound leather notebooks at a special price. Message us to order.",
      "Hand-made notebooks with leather covers in several colours, delivered inside the city. Ask us for details.",
    ],
    firstComment: "Message us for details and prices.",
    lastGroup: "Cairo Bikes Exchange",
    people: [
      ["Mona Sayed", "LOVE", "Interested in the notebooks, please send details on WhatsApp"],
      ["Karim Nassar", "LIKE", "How much is the large one? My number is below"],
      ["Huda Masri", "LIKE", ""],
      ["Samer Khalil", "WOW", "Do you deliver to Alexandria? Contact me on this number"],
      ["Rana Abdallah", "LOVE", ""],
      ["Tarek Fouad", "LIKE", "I would like three copies, WhatsApp"],
      ["Yasmine Darwish", "LIKE", ""],
      ["Omar Shaheen", "HAHA", "Contact me about a bulk order for the shop"],
      ["Dina Hosny", "LOVE", ""],
      ["Bassam Rifai", "LIKE", "Interested, my number is in the comment"],
    ],
  },
};

const AR_TOPICS = [
  "الكتب المستعملة",
  "الدراجات الهوائية",
  "الأثاث المنزلي",
  "الأجهزة الإلكترونية",
  "مستلزمات الأطفال",
  "الأدوات الرياضية",
  "النباتات المنزلية",
  "الصناعات اليدوية",
  "الكاميرات والتصوير",
  "الأدوات الموسيقية",
  "قطع غيار السيارات",
  "ألعاب الفيديو",
  "الأزياء المستعملة",
  "أدوات المطبخ",
  "أدوات الحدائق",
];
const AR_FORMATS = ["سوق", "تبادل", "مجتمع", "هواة"];

const EN_CITIES = [
  "Cairo",
  "Alexandria",
  "Amman",
  "Riyadh",
  "Dubai",
  "Beirut",
  "Casablanca",
  "Tunis",
  "Doha",
  "Muscat",
  "Kuwait City",
  "Manama",
];
const EN_TOPICS = ["Bikes Exchange", "Book Swap", "Home Decor Market", "Plant Lovers", "Handmade Corner"];

/** Deterministic pseudo-random sequence, so every capture run draws the same list. */
function lcg(seed) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

/** About 120 groups, Arabic and English names alternating. */
function buildGroups() {
  const arabic = AR_TOPICS.flatMap((topic) => AR_FORMATS.map((format) => `${format} ${topic}`));
  const english = EN_CITIES.flatMap((city) => EN_TOPICS.map((topic) => `${city} ${topic}`));
  const rand = lcg(7);
  const names = [];
  for (let i = 0; i < Math.max(arabic.length, english.length); i += 1) {
    if (arabic[i]) names.push(arabic[i]);
    if (english[i]) names.push(english[i]);
  }
  return names.map((name, i) => ({
    id: `2000000000${String(i + 1).padStart(3, "0")}`,
    name,
    memberCount: 800 + Math.floor(rand() * 47_000),
    requiresApproval: rand() < 0.3,
  }));
}

/** Ten people, most with a made-up number. `lang` picks the script of their names. */
function buildAudience(lang, now) {
  const rows = TEXT[lang].people.map(([name, reaction, comment], i) => {
    const number = `+20100000${String(i + 1).padStart(4, "0")}`;
    const hasNumber = comment !== "";
    const sighting = {
      source: i % 3 === 2 ? "post.reactor" : "post.commenter",
      postUrl: "https://www.facebook.com/groups/2000000000001/posts/3000000000001/",
      feedbackId: "ZmVlZGJhY2s6MzAwMDAwMDAwMDAwMQ==",
      reaction,
      capturedAt: now - 20 * MINUTE,
      ...(comment
        ? { commentId: `4000000000${String(i + 1).padStart(3, "0")}`, text: comment, createdAt: Math.floor((now - 3 * 60 * MINUTE) / 1000) }
        : {}),
    };
    const contacts = hasNumber
      ? [
          {
            kind: "phone",
            value: number,
            confidence: i % 4 === 0 ? 0.62 : 0.95,
            region: "EG",
            raw: number,
            whatsapp: i % 2 === 0,
          },
        ]
      : [];
    return {
      id: `1000000000${String(i + 10).padStart(5, "0")}`,
      name,
      contacts,
      sightings: [sighting],
      bestConfidence: contacts[0]?.confidence ?? 0,
      firstSeenAt: now - 20 * MINUTE,
      lastSeenAt: now - 20 * MINUTE,
    };
  });
  // The people with a number first, as the real table does.
  return rows.sort((a, b) => b.bestConfidence - a.bestConfidence);
}

/** The Facebook operations list: a few of the real names, one id learned from a tab. */
function buildDocIds(now) {
  const bundled = bundledDocIds(DEFAULT_FB_RECIPE);
  const shown = [
    "ComposerStoryCreateMutation",
    "GroupsCometJoinsRootQuery",
    "GroupsCometAllJoinedGroupsSectionPaginationQuery",
    "GroupsCometLeaveDialogQuery",
    "CometUFIReactionsDialogQuery",
    "CommentListComponentsRootQuery",
    "useCometUFICreateCommentMutation",
  ].filter((name) => name in bundled);
  const learned = "GroupsCometJoinsRootQuery";
  return shown.map((name) =>
    name === learned
      ? // Same shape as a real id, but not one: it only has to look learned.
        { name, active: "9000000000" + bundled[name].slice(-6), source: "learned", seenAt: now - 95 * MINUTE }
      : { name, active: bundled[name], source: "bundled" },
  );
}

/**
 * What the Logs page lists. Messages are the ones the service worker really writes.
 * The log is a monospaced, left-to-right list, so the group names in it are Latin in
 * both languages: Arabic letters do not join in a monospaced face.
 */
function buildLogs(now) {
  const groups = ["Amman Book Swap", "Dubai Plant Lovers", "Doha Handmade Corner"];
  const group = "Cairo Bikes Exchange";
  const at = (minutesAgo) => now - minutesAgo * MINUTE;
  return [
    { ts: at(14), level: "info", msg: "Run started", meta: { jobs: 12 } },
    { ts: at(12), level: "info", msg: `Posted → ${groups[0]}` },
    { ts: at(10), level: "info", msg: `Posted → ${groups[1]}` },
    { ts: at(8), level: "warn", msg: "Post held back to stay inside the call budget" },
    { ts: at(6), level: "info", msg: `Posted → ${groups[2]}` },
    { ts: at(4), level: "info", msg: "First comment", meta: { status: "ok" } },
    { ts: at(2), level: "info", msg: `Posted → ${group}` },
  ];
}

/**
 * Everything the fake service worker answers with, for one scenario.
 * `now` is a parameter; the harness passes its frozen clock so every run draws the same data.
 */
export function buildSeed({ lang, run, update, now }) {
  const text = TEXT[lang];
  const groups = buildGroups();
  const audience = buildAudience(lang, now);
  const account = {
    id: "acc_100000000000001",
    fbUserId: "100000000000001",
    label: text.name,
    name: text.name,
    addedAt: now - 40 * 24 * 60 * MINUTE,
    health: "ok",
    lastActiveAt: now - 3 * MINUTE,
    dailyCounts: {},
  };
  const session = {
    loggedIn: true,
    tokensReady: true,
    hasOpenTab: true,
    profile: { fbUserId: "100000000000001", name: text.name },
    profileFresh: true,
  };

  return {
    text,
    groups,
    account,
    session,
    syncedAt: now - 4 * MINUTE,
    // Names in the page's own script, so a screenshot is not a mix of two directions.
    selectedGroupIds: groups
      .filter((g) => /[\u0600-\u06FF]/.test(g.name) === (lang === "ar"))
      .slice(0, 12)
      .map((g) => g.id),
    draft: {
      variations: text.captions,
      firstComment: text.firstComment,
      // The spacing the app itself recommends for a batch this size.
      delay: { mode: "range", minSeconds: 180, maxSeconds: 1200 },
    },
    snapshot: run
      ? {
          runId: "run_demo",
          status: "running",
          total: 12,
          done: 6,
          published: 5,
          pending: 1,
          failed: 0,
          lastGroupName: text.lastGroup,
          nextWakeAt: now + 47_000,
          activeAccountId: null,
        }
      : null,
    update: update
      ? {
          status: "available",
          current: "1.0.0",
          checkedAt: now - 12 * MINUTE,
          latest: {
            version: "1.0.1",
            publishedAt: new Date(now - 26 * 60 * MINUTE).toISOString(),
            notesUrl: "https://github.com/abdumezar/extensions.facebook.auto/releases/tag/v1.0.1",
            zipUrl: "https://github.com/abdumezar/extensions.facebook.auto/releases/download/v1.0.1/nashir-1.0.1.zip",
            sigUrl: "https://github.com/abdumezar/extensions.facebook.auto/releases/download/v1.0.1/nashir-1.0.1.zip.sig",
          },
        }
      : { status: "idle", current: "1.0.0", checkedAt: now - 12 * MINUTE },
    extraction: {
      status: "done",
      postUrl: "https://www.facebook.com/groups/2000000000001/posts/3000000000001/",
      feedbackId: "ZmVlZGJhY2s6MzAwMDAwMDAwMDAwMQ==",
      groupId: "2000000000001",
      found: audience.length,
      withContact: audience.filter((r) => r.contacts.length > 0).length,
      reactorPages: 1,
      commentPages: 1,
      totalComments: audience.filter((r) => r.sightings.some((s) => s.text)).length,
      startedAt: now - 22 * MINUTE,
      finishedAt: now - 20 * MINUTE,
      truncated: false,
    },
    audience,
    docIds: buildDocIds(now),
    governor: {
      cooldown: null,
      callsLastHour: 37,
      callsLastMinute: 1,
      byClass: { "mutation.post": 9, "read.groups": 14, "read.audience": 11, "mutation.comment": 3 },
    },
    logs: buildLogs(now),
  };
}
