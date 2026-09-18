# iOS Setup — покроковий гайд

Цей гайд для разової Mac-сесії: побудова WebDriverAgent.ipa і експорт на Windows.

## ЩО ПОТРІБНО ВЗЯТИ З СОБОЮ ДО ДРУГА

1. **iPhone 8** з кабелем (USB-A → Lightning)
2. **Власний email** для реєстрації Apple ID (якщо ще немає)
3. **UDID iPhone'а** (отримуємо нижче в кроці 0)
4. **Флешка / Google Drive** — щоб віднести готовий .ipa файл назад

## КРОК 0: ОТРИМАТИ UDID iPhone (на Windows ДО Mac-сесії)

Підключи iPhone до Windows через USB. На iPhone натисни "Trust this computer".

Спосіб 1 — через нашу програму (швидкий):
```bash
cd "C:/claude code/reels-generator/tools/ios"
./ios.exe list
```
Виведе список UDID'ів — скопіюй той що Mi MIX (iPhone 8). UDID — це 25-символьний рядок типу `00008030-001234567890ABCD`.

Спосіб 2 — через 3uTools (GUI): встанови з 3u.com → відкрий → UDID видно одразу на головному екрані.

**Збережи UDID** — без нього Mac-сесія не пройде.

---

## MAC-СЕСІЯ (~30-45 хвилин у друга)

### КРОК 1: Встановити Xcode (якщо у друга ще нема)

App Store → шукай "Xcode" → встановити. Це 13 GB, скачування може зайняти 15-30 хв. Це найдовший етап — попроси друга встановити **до твого приходу**.

### КРОК 2: Apple ID + Free Developer

Якщо в тебе вже є Apple ID — використай його. Інакше:
1. На Mac: System Settings → Apple ID → Create Apple ID (free)
2. Заходимо на https://developer.apple.com/account → Sign in
3. Apple покаже "Welcome to Apple Developer" — тицяй "Agree"

Free dev account активується автоматично, $99 НЕ платимо.

### КРОК 3: Зареєструвати iPhone в Xcode

1. Підключи свій iPhone до Mac через USB
2. На iPhone: "Trust this computer"
3. На iPhone: Settings → Privacy & Security → Developer Mode → ON (треба перезавантажити iPhone, ввести pin після reboot)
4. Відкрий Xcode → меню `Window` → `Devices and Simulators`
5. Має побачити iPhone у списку. Якщо ні — почекай 30 сек, або перепідключи USB.
6. Внизу екрана буде "Use for development" → натисни. Xcode зробить registration в Apple.

### КРОК 4: Завантажити WebDriverAgent

У терміналі Mac:
```bash
cd ~/Desktop
git clone https://github.com/appium/WebDriverAgent.git
cd WebDriverAgent
```

### КРОК 5: Відкрити в Xcode і налаштувати signing

```bash
open WebDriverAgent.xcodeproj
```

Це відкриє Xcode з проєктом. Тепер:

1. Зліва у Project Navigator натисни на корінь "WebDriverAgent" (синя іконка)
2. У центрі — таб **Signing & Capabilities**
3. У дропдауні **Targets** (зліва вгорі від таба) → вибери **WebDriverAgentRunner**
4. Постав ✅ "**Automatically manage signing**"
5. **Team** → вибери свій Apple ID (там буде "Twoye Imya (Personal Team)")
6. **Bundle Identifier** — Xcode може ругатись що bundle id зайнятий. Якщо ругається — зміни на унікальний типу `com.{твоє_імʼя}.WDA.runner` (приклад: `com.maks.wda.runner`)

Поки залишай target = WebDriverAgentRunner. Якщо є ще target "IntegrationApp" — зроби те саме з ним (унікальний bundle id, твій Team).

### КРОК 6: Build

1. Вгорі біля кнопки Play (▶︎) обери target **WebDriverAgentRunner** (не Lib)
2. Поряд — обери свій iPhone (має бути в дропдауні раз ти його зареєстрував у кроці 3)
3. Меню `Product` → `Test` (або `⌘+U`)
4. Xcode почне build (~2-3 хв)
5. На iPhone випливе "Untrusted Developer". Це нормально.
   - На iPhone: Settings → General → VPN & Device Management → твій Apple ID → "Trust"
6. Повтори `⌘+U` в Xcode — цього разу WDA встановиться і запуститься на iPhone

**Перевірка**: на iPhone мав з'явитися додаток з білою іконкою "WebDriverAgentRunner". Якщо так — все добре.

### КРОК 7: Експорт IPA (для Windows)

Тепер маємо WDA встановлений на iPhone, але нам треба **сам IPA файл**, щоб переустановлювати з Windows без Mac.

У терміналі Mac:
```bash
cd ~/Desktop/WebDriverAgent
xcodebuild -project WebDriverAgent.xcodeproj \
  -scheme WebDriverAgentRunner \
  -destination "generic/platform=iOS" \
  -configuration Debug \
  -derivedDataPath build/ \
  archive -archivePath build/WDA.xcarchive

# Тепер експорт IPA
mkdir -p ~/Desktop/wda-export
cat > ~/Desktop/wda-export/exportOptions.plist <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key>
  <string>development</string>
  <key>signingStyle</key>
  <string>automatic</string>
  <key>teamID</key>
  <string>ТВІЙ_TEAM_ID</string>
</dict>
</plist>
EOF

# ТВІЙ_TEAM_ID — знайди в Xcode → Signing & Capabilities → справа від Team побачиш короткий код типу "ABCD1234EF"
# або через термінал: security find-identity -v -p codesigning | grep "Apple Development"

xcodebuild -exportArchive \
  -archivePath build/WDA.xcarchive \
  -exportOptionsPlist ~/Desktop/wda-export/exportOptions.plist \
  -exportPath ~/Desktop/wda-export
```

В `~/Desktop/wda-export/` має з'явитись `WebDriverAgentRunner-Runner.ipa`. **Це і є наш файл.**

### КРОК 8: Перенести IPA на Windows

Скопіюй файл `WebDriverAgentRunner-Runner.ipa` на флешку (або через Google Drive, Dropbox, AirDrop на твій Windows ноут якщо він підтримує).

На Windows зберігаємо в:
```
C:\claude code\reels-generator\tools\ios\WDA.ipa
```

(Перейменуй на `WDA.ipa` для простоти.)

### КРОК 9 (готово на Mac): Записати UDID іншого iPhone

Якщо плануєш потім додати **iPhone 11 з iOS 26**, попроси друга підключити цей iPhone теж і повторити Крок 3 на ньому. Потім IPA треба буде PEREbuilds окремо, бо provisioning profile різний для різних UDID.

---

## ПОВЕРНЕННЯ НА WINDOWS

Тепер скажи мені — я доєднаю WDA до системи:

```bash
# 1. Встановити WDA на iPhone з Windows
cd "C:/claude code/reels-generator/tools/ios"
./ios.exe install --path=./WDA.ipa --udid=ТВІЙ_UDID

# 2. Запустити WDA через XCTest
./ios.exe runxctest --bundle-id=com.facebook.WebDriverAgentRunner.xctrunner --udid=ТВІЙ_UDID
# (це буде блокуючий процес — залиш термінал відкритим)

# 3. У ДРУГОМУ терміналі — port forward (WDA HTTP server slухає на порту 8100 на iPhone)
./ios.exe forward 8100 8100 --udid=ТВІЙ_UDID

# 4. Тест: WDA повинен відповісти
curl http://localhost:8100/status
# Має повернути JSON з info про WDA
```

Якщо `/status` повернув JSON — **PoC pipeline робочий**. Скажи мені — підключаю реальну логіку posting у `ios_poster.py`.

---

## ВАЖЛИВІ НЮАНСИ

**Cert живе 7 днів** (free Apple ID). Через тиждень WDA перестане запускатися: при `ios runxctest` побачиш "Untrusted Developer". Рішення:
- **Швидке**: повторити Крок 6 (`⌘+U` у Xcode) — Xcode auto-renews cert. Треба буде 5 хв на Mac.
- **Постійне**: купити Apple Developer Program $99/рік → cert живе 1 рік замість 7 днів.

**Якщо Apple Dev купиш**: після оплати в Xcode `Signing & Capabilities` Team зміниться з "Personal Team" на "ТВОЄ_ІМ'Я (Apple Development)" — і той самий Build вже буде підписаний на 365 днів.

**iPhone reboot ламає WDA**: якщо iPhone перезавантажився, WDA треба запускати знов через `ios runxctest`. Сам WDA додаток лишається на iPhone, тільки XCTest сесія обривається.

**Multi-iPhone**: для кожного нового iPhone треба зареєструвати UDID в Xcode (Крок 3) і ОДИН раз перебудувати WDA (Крок 5-7), бо provisioning profile прив'язаний до конкретних UDID. На free account ліміт 100 UDID/рік на тип пристрою.

---

## ШВИДКИЙ ЧЕК-ЛИСТ ПЕРЕД ПОЇЗДКОЮ ДО ДРУГА

- [ ] Apple ID знаю / готовий створити
- [ ] UDID iPhone'а збережений (з кроку 0)
- [ ] iPhone розблокований, з активним Wi-Fi
- [ ] Lightning кабель з собою
- [ ] Друг має Mac з macOS 13+ і встановленим Xcode
- [ ] Флешка для перенесення IPA
