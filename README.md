# TG Personal Client — کلاینت شخصی تلگرام بدون فیلترشکن

بک‌اند TDLib روی Railway + REST/WebSocket API + داشبورد ادمین.
اپ موبایل فقط با دامنه Railway صحبت می‌کند؛ ارتباط مستقیم با تلگرام فقط از سرور.

## وضعیت تست (روی این سرور اجرا و پاس شده)

| تست | نتیجه |
|---|---|
| `npm run smoke` — لود libtdjson + رسیدن به `authorizationStateWaitPhoneNumber` | ✅ |
| `npm test` — ۱۴ تست امنیتی و API (توکن، rate-limit، WS auth، state machine) | ✅ 14/14 |
| TDLib واقعی با api_id جعلی تا مرحله انتظار شماره | ✅ |

## راه‌اندازی روی Railway (گام‌به‌گام)

1. **api_id و api_hash** از [my.telegram.org](https://my.telegram.org) بگیرید.
2. این ریپو را به GitHub خودتان push کنید (`.gitignore` دیتابیس سشن را از گیت نگه می‌دارد).
3. Railway: **New Project → Deploy from GitHub repo**.
4. **Variables** را ست کنید (مقادیر `.env.example`):
   - `API_ID`, `API_HASH`
   - `CLIENT_TOKEN` (رشته تصادفی بلند؛ اپ موبایل باید آن را در header `x-api-token` بفرستد)
   - `ADMIN_USER` و `ADMIN_PASSWORD_HASH`
     (`node -e "console.log(require('crypto').createHash('sha256').update('YOURPASS').digest('hex'))"`)
5. **Volume**: Service → Settings → Volumes → attach، مسیر mount: `/data`
   (بدون این کار با هر deploy دوباره باید لاگین کنید!)
6. **Domain**: Settings → Networking → Generate Domain → دامنه HTTPS آماده است.
7. Deploy. داشبورد: `https://<دامنه>/admin`
8. در داشبورد: ورود با ADMIN_USER/password → **Start** (اگر خودکار شروع نشد) → ارسال شماره → کد → رمز 2FA در صورت نیاز.
9. تست اتصال: `curl -H "x-api-token: $CLIENT_TOKEN" https://<دامنه>/api/chats`

## API (همه با هدر `x-api-token`)

| Endpoint | توضیح |
|---|---|
| `GET /api/me` | پروفایل حساب |
| `GET /api/chats?limit=20&offset=0` | لیست چت‌ها |
| `GET /api/chats/:id/messages?limit=30&from_message_id=0` | تاریخچه (صفحه‌بندی) |
| `POST /api/chats/:id/messages` | `{text}` یا `{file_id, type: photo\|file\|voice, text}` |
| `GET /api/files/:id` | دانلود فایل |
| `WS /ws` | بعد از اتصال بفرست: `{"type":"hello","token":"..."}` → سپس `newMessage`، `updateChatAction`، `updateUserStatus` push می‌شود |

## امنیت — چک‌لیست

- دیتابیس سشن = دسترسی کامل اکانت. فقط روی Volume، هرگز در گیت/لاگ.
- `ADMIN_PASSWORD_HASH` و `CLIENT_TOKEN` را حتماً ست کنید (اگر نه، سرور هشدار می‌دهد و داشبورد با رمز پیش‌فرض خطرناک است).
- لاگین ادمین: ۵ تلاش در ۱۰ دقیقه per IP. Activity log در `/admin/activity`.
- Railway TLS روی دامنه پیش‌فرض فعال است (HTTPS/WSS).
- نکته: فقط یک admin session store in-memory است؛ ری‌استارت = لاگین مجدد ادمین (عمدی).

## نکات شناخته‌شده (صادقانه)

- `GET /api/files/:id` در این نسخه همگام دانلود می‌کند و برای فایل‌های بزرگ timeout می‌گیرد؛ نسخه بعد: دانلود async + progress روی WS.
- Rate-limit های تلگرام را TDLib مدیریت می‌کند (`FLOOD_WAIT` به‌صورت `td_code: 429` در پاسخ API می‌آید)؛ backoff سمت اپ هم توصیه می‌شود.
- multer نصب است ولی آپلود مستقیم فایل از اپ در نسخه بعد (`POST /api/upload`).
- هنوز پیاده نشده: PWA/اپ موبایل (مرحله ۴ بریف)، IP whitelist ادمین، ذخیره پایدار activity log.
