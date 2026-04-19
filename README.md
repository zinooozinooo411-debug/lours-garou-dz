# 🐺 ليلة الذياب — Laylat el Diyab

لعبة المافيا بالدارجة الجزائرية — Multiplayer Online

## الأدوار
| الدور | الاسم | الفريق | الخاصية |
|-------|-------|--------|---------|
| 🐺 | الذيب | الذياب | يقتل القرويين ليلاً |
| 🔕 | ذيب التسكيت | الذياب | يسكت لاعب كل ليلة |
| 👨‍⚕️ | الطبيب | القرية | ينقذ لاعب من القتل |
| 🔍 | الشواف | القرية | يكشف هوية لاعب |
| 👴 | شيخ القبيلة | القرية | صوته = 3 أصوات (منتخب) |
| 😇 | الولد الصالح | القرية | عند طرده يختار واحد معه |
| 🧑 | مدني | القرية | يصوت فقط |

## التشغيل محلياً

```bash
npm install
npm run dev
# افتح http://localhost:3000
```

## النشر على Railway

### الطريقة الأولى: GitHub (موصى بها)

1. **ارفع الكود على GitHub**:
```bash
git init
git add .
git commit -m "🐺 ليلة الذياب - أول إصدار"
git remote add origin https://github.com/USERNAME/laylat-diyab.git
git push -u origin main
```

2. **انشئ حساب على [railway.app](https://railway.app)**

3. **اضغط New Project → Deploy from GitHub repo**

4. **اختار الريبو** — Railway يكتشف تلقائياً إعدادات Node.js

5. **اضغط Deploy** — في 2 دقيقة اللعبة تشتغل!

6. **احصل على رابطك**: Settings → Domains → Generate Domain

### الطريقة الثانية: Railway CLI

```bash
npm install -g @railway/cli
railway login
railway init
railway up
```

## إضافة Voice Chat حقيقي (Agora.io)

1. سجل على [agora.io](https://agora.io) — مجاني 10,000 دقيقة/شهر
2. أنشئ project واحصل على App ID
3. أضف في `.env`:
```
AGORA_APP_ID=your_app_id_here
```
4. أضف Agora SDK في `client/public/index.html`:
```html
<script src="https://download.agora.io/sdk/release/AgoraRTC_N-4.x.x.js"></script>
```
5. استبدل دالة `toggleMic()` بـ Agora API

## هيكل المشروع

```
laylat-diyab/
├── server/
│   └── index.js          ← منطق اللعبة + Socket.io
├── client/
│   └── public/
│       └── index.html    ← الواجهة الكاملة
├── package.json
├── railway.json
└── README.md
```

## عدد اللاعبين
- الحد الأدنى: 6 لاعبين
- الحد الأقصى: 15 لاعباً
- عدد الذياب: من 1 حتى 5 (يختاره المضيف)
