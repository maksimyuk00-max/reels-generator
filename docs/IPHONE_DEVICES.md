# iPhone пристрої

Реєстр всіх iPhone'ів які буде керувати програма. Оновлюється коли додаємо/реєструємо новий пристрій.

---

## iPhone #1 — iPhone 8

**Базова інформація:**
| Поле | Значення |
|---|---|
| UDID | `10bf25e2186470c2f361f1459245af0baa76d79e` |
| Серійний номер | `FFNZDA74JC6C` |
| Модель (internal) | `iPhone10,1` |
| Модель (commercial) | iPhone 8 (4.7" дисплей) |
| Hardware Model | `D20AP` |
| Hardware Platform | `t8015` (Apple A11 Bionic) |
| Model Number | `MQ6K2` |
| Колір | `1` (Space Gray) |
| Регіон | `LL/A` (USA) |

**Системне:**
| Поле | Значення |
|---|---|
| iOS версія | `16.7.14` |
| Build | `20H370` |
| Firmware | `iBoot-8422.142.2.700.1` |
| CPU Architecture | `arm64` |
| ChipID | `0x8015` |
| Production SOC | True |
| Activation State | `Activated` |

**Мережа:**
| Поле | Значення |
|---|---|
| WiFi MAC | `88:b2:91:ba:b5:81` |
| Bluetooth MAC | `88:b2:91:c8:41:61` |
| Ethernet MAC | `88:b2:91:bf:96:a1` |

**Користувач:**
| Поле | Значення |
|---|---|
| Назва пристрою | "Dan's iPhone" |
| Часовий пояс | `US/Pacific` (UTC-7) |
| 24-hour clock | False |
| Password protected | False |
| Find My (fm) | Активовано на власному акаунті (`fm-activation-locked: YES`) |
| iCloud account (masked) | `d•••••@icloud.com` |
| Власник | Я (підтверджено) |

**Статус інтеграції з reels-generator:**
| Поле | Значення |
|---|---|
| Перше виявлення | 2026-05-04 |
| WDA встановлений | ❌ Ні (потрібна Mac-сесія) |
| Apple Dev cert | ❌ Не оформлений (буде free 7-day після Mac-сесії) |
| Cert expires at | — |
| Додано в DB | ❌ Ні |

**Команди для роботи з цим пристроєм:**

```bash
# Перевірити чи підключений
"C:/claude code/reels-generator/tools/ios/ios.exe" list

# Отримати повне інфо
"C:/claude code/reels-generator/tools/ios/ios.exe" info --udid=10bf25e2186470c2f361f1459245af0baa76d79e

# Встановити WDA (після Mac-сесії)
"C:/claude code/reels-generator/tools/ios/ios.exe" install --path=./WDA.ipa --udid=10bf25e2186470c2f361f1459245af0baa76d79e

# Запустити WDA сервер
"C:/claude code/reels-generator/tools/ios/ios.exe" runxctest \
    --bundle-id=com.facebook.WebDriverAgentRunner.xctrunner \
    --udid=10bf25e2186470c2f361f1459245af0baa76d79e

# Port forward (WDA HTTP server 8100)
"C:/claude code/reels-generator/tools/ios/ios.exe" forward 8100 8100 \
    --udid=10bf25e2186470c2f361f1459245af0baa76d79e
```

**Find My / iCloud:** активний на твоєму акаунті — все ОК, не заважає WDA. Жодних обмежень для Mac-сесії і подальшої роботи.

---

## iPhone #2 — iPhone 11 (з iOS 26.3)

**Статус:** ❌ Ще не підключений до програми

Підключи через USB → запусти `tools/ios/ios.exe list` → дані додам сюди.

**Очікувані складнощі з iOS 26:**
- WDA може потребувати свіжу версію (приблизно WDA 7.0+)
- Lockdown daemon на iOS 17+ потребує `ios tunnel start` перед командами (вже бачу warning у виводі go-ios)
- Mac-сесія для цього iPhone — окрема, бо provisioning profile прив'язаний до конкретних UDID

---

## Загальні нотатки

**Apple Dev акаунт:** один (твій). Free 7-day cert для PoC. Якщо знадобиться $99/рік — упишу сюди дату активації.

**Multi-device на free Apple ID:**
- Лімит 3 sideloaded apps на ОДИН iPhone (не на акаунт)
- WDA = 1 додаток. Тобі залишається 2 free слоти на кожному пристрої.
- iPhone'ів у власному free аккаунті можна реєструвати скільки завгодно

**Якщо UDID треба буде дізнатись повторно** (наприклад вирішив подаритись iPhone комусь, потім назад взяв) — UDID не змінюється протягом життя пристрою. Збережений тут — зберігається і для наступних setup'ів.
