# Drive Direct Link — Cloudflare Worker

שירות קישור ישיר לקבצים ציבוריים ב־Google Drive, כמו `gdrive.tjbot.workers.dev` — Worker אחד, בלי שרת, בלי מסד נתונים, בלי תלויות חיצוניות.

## מה יש בפנים

| קובץ | תפקיד |
| --- | --- |
| `worker.js` | כל הקוד: דף הבית, ה־API, ההורדה הישירה, דף הקובץ |
| `wrangler.toml` | הגדרות הפריסה של Cloudflare |
| `README.md` | הקובץ הזה — הוראות פריסה |

## מסלולים

- `/` — דף הבית: מדביקים קישור דרייב → שם, גודל, סוג, קישור הורדה ישיר + קישור צפייה/סטרימינג לסרטונים, עם כפתור העתקה.
- `/api?url=<קישור דרייב או ID>` — מחזיר JSON:
  ```json
  { "ok": true, "type": "file", "id": "…", "name": "Spowlo-1.4.1.apk",
    "size": 88495000, "size_human": "84.4 MB", "mime": "application/vnd.android.package-archive",
    "ext": "apk", "direct": "https://<you>.workers.dev/dl/<id>/Spowlo-1.4.1.apk",
    "page": "https://<you>.workers.dev/f/<id>" }
  ```
  לתיקייה: `type: "folder"` + מערך `items` עם הקבצים שבפנים.
- `/dl/<file-id>/<filename>` — הורדה ישירה, עם תמיכה ב־`Range` (סטרימינג וחיפוש קדימה/אחורה בסרטונים). השם בסוף קובע את שם הקובץ שיירד.
- `/f/<file-id>` — דף קובץ פשוט עם כפתור הורדה (וסרטון/אודיו/תמונה מוטמעים כשזה מתאים).

## איך זה עובד מאחורי הקלעים

1. חילוץ ה־ID מכל פורמט: `/file/d/<id>/view`,‏ `open?id=<id>`,‏ `uc?id=<id>`,‏ `/drive/folders/<id>` או ID גולמי.
2. מטא־דאטה (שם, גודל, סוג) דרך Drive API v3 ‏(`files.get`) עם מפתח ב־Secret בשם `GOOGLE_API_KEY`. בלי מפתח — נופל לקריאת דף הקובץ הציבורי (scraping) כדי לשלוף שם/גודל.
3. תיקיות: `files.list` עם `q="'<id>' in parents"` (דורש מפתח API — בלי מפתח מחזיר הודעה ברורה).
4. הורדה: בקשה ל־`drive.google.com/uc?export=download&id=<id>`. בקבצים גדולים גוגל מחזירה דף אזהרת סריקת וירוסים — ה־Worker שולף ממנו את ה־`confirm` (וגם `uuid` אם יש) ומבקש שוב **מכתובת הטופס עצמו** (`drive.usercontent.google.com/download`, כמו שהטופס של גוגל עושה — בקשה חוזרת ל־`/uc` מאבדת את הטוקן בהפניה). אחר כך הוא מזרים את התשובה של גוגל ישר למשתמש בלי לטעון את הקובץ לזיכרון, ומעביר הלאה `Range` / `Content-Range` / `206` כדי שסטרימינג יעבוד. בלי מפתח API, הגודל המדויק נשלף באותה דרך — בקשת `Range: bytes=0-0` וה־`Content-Range` מחזיר את הסך הכולל.
5. רק קבצים ציבוריים ("Anyone with the link") עובדים. קובץ פרטי מחזיר שגיאת JSON ברורה.

## פריסה — צעד אחר צעד

### שלב 0 — מה צריך

- חשבון Cloudflare חינמי.
- Node.js מותקן (במחשב, או ב־Termux: `pkg install nodejs`).
- מפתח Google API — חינמי, בלי כרטיס אשראי (הסבר בשלב 1). **מומלץ מאוד**: בלי מפתח, תיקיות לא יוצגו והמטא־דאטה פחות אמין.

### שלב 1 — יצירת מפתח Google API (חינם)

1. פתחו [Google Cloud Console](https://console.cloud.google.com/) והתחברו.
2. צרו פרויקט חדש (או בחרו קיים): למעלה `Select a project` ← `New Project` ← שם כלשהו ← `Create`.
3. בתפריט הצד: `APIs & Services` ← `Library` ← חפשו **Google Drive API** ← `Enable`.
4. בתפריט הצד: `APIs & Services` ← `Credentials` ← למעלה `+ Create Credentials` ← `API key`.
5. העתיקו את המפתח. מומלץ להגביל אותו: לחצו על המפתח ← `API restrictions` ← `Restrict key` ← סמנו רק **Google Drive API** ← `Save`.

### שלב 2 — פריסת ה־Worker

```bash
# 1. נכנסים לתיקיית הפרויקט (איפה ש־worker.js ו־wrangler.toml נמצאים)
cd gdrive-worker

# 2. התחברות ל־Cloudflare (יפתח דפדפן לאישור, פעם אחת)
npx wrangler login

# 3. שמירת מפתח גוגל כ־Secret (לא בקובץ, לא בקוד)
npx wrangler secret put GOOGLE_API_KEY
# מדביקים את המפתח משלב 1 ולוחצים Enter

# 4. פריסה
npx wrangler deploy
```

בסוף הפלט תופיע הכתובת, למשל:

```
https://gdrive-direct-link.<your-name>.workers.dev
```

אפשר לשנות את השם: ערכו את `name = "gdrive-direct-link"` ב־`wrangler.toml` ופרסו שוב.

### שלב 3 — בדיקה

```bash
# דף הבית
curl https://<you>.workers.dev/

# API על קישור דרייב ציבורי
curl "https://<you>.workers.dev/api?url=https://drive.google.com/file/d/<FILE_ID>/view"

# הורדה ישירה
curl -L -o test.apk "https://<you>.workers.dev/dl/<FILE_ID>/test.apk"
```

אם משהו לא עובד — `npx wrangler tail` מראה לוגים חיים מה־Worker.

## עדכונים אוטומטיים דרך גיט

הריפו מחובר ל־Cloudflare Workers Builds: כל push לענף `main` מפעיל בנייה ופריסה אוטומטית של ה־Worker. אין צורך לגעת בעורך של קלאודפלייר — מעדכנים את `worker.js` בריפו, והפריסה קורית לבד תוך דקה בערך.

שימו לב: שם ה־Worker בדשבורד חייב להיות זהה ל־`name` ב־`wrangler.toml` (כרגע `gdrive-direct-link`), אחרת הבנייה נכשלת.

## מגבלות שכדאי לדעת

- **תוכנית חינמית של Cloudflare:** 100,000 בקשות ביום. הורדת קובץ גדול נספרת כבקשה אחת, אבל Cloudflare מעבירה דרכה את כל התעבורה — קבצים ענקיים בתדירות גבוהה עלולים להיתקל במגבלות.
- **מכסת Drive API:** מפתח API חינמי מוגבל (ברירת מחדל ~10,000 בקשות ל־100 שניות לפרויקט) — מספיק לשימוש רגיל.
- **קבצים פרטיים לא עובדים** — רק "Anyone with the link".
- **גוגל משנה לפעמים את דף האזהרה** — אם הורדת קובץ גדול מפסיקה לעבוד, סביר שה־`confirm` השתנה; בדקו את הלוגים עם `wrangler tail`.
