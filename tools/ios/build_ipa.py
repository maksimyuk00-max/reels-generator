"""Завантажує precompiled WDA з Appium GitHub і пакує в правильну .ipa структуру.

Корисно для Sideloadly re-sign workflow без Mac.
"""
import os
import shutil
import urllib.request
import zipfile

WDA_URL = "https://github.com/appium/WebDriverAgent/releases/download/v12.2.0/WebDriverAgentRunner-Runner.zip"

HERE = os.path.dirname(os.path.abspath(__file__))
ZIP_PATH = os.path.join(HERE, "wda-source.zip")
EXTRACT_DIR = os.path.join(HERE, "wda-extracted")
IPA_PATH = os.path.join(HERE, "WDA.ipa")


def main():
    print("Downloading WDA from Appium GitHub releases...")
    urllib.request.urlretrieve(WDA_URL, ZIP_PATH)
    print(f"  -> {os.path.getsize(ZIP_PATH)} bytes")

    if os.path.exists(EXTRACT_DIR):
        shutil.rmtree(EXTRACT_DIR)
    os.makedirs(EXTRACT_DIR)

    print("Extracting...")
    with zipfile.ZipFile(ZIP_PATH, "r") as z:
        z.extractall(EXTRACT_DIR)

    src_app = os.path.join(EXTRACT_DIR, "WebDriverAgentRunner-Runner.app")
    if not os.path.isdir(src_app):
        print("ERROR: WebDriverAgentRunner-Runner.app not found in archive")
        return 1

    print("Packaging as .ipa with Payload/ structure...")
    if os.path.exists(IPA_PATH):
        os.remove(IPA_PATH)

    with zipfile.ZipFile(IPA_PATH, "w", zipfile.ZIP_DEFLATED) as ipa:
        for root, dirs, files in os.walk(src_app):
            for f in files:
                full = os.path.join(root, f)
                rel = os.path.relpath(full, EXTRACT_DIR)
                arc = "Payload/" + rel.replace(os.sep, "/")
                ipa.write(full, arc)

    print("Cleanup...")
    shutil.rmtree(EXTRACT_DIR)
    os.remove(ZIP_PATH)

    size = os.path.getsize(IPA_PATH)
    print(f"\nReady: {IPA_PATH}")
    print(f"Size: {size:,} bytes ({size / 1024 / 1024:.2f} MB)")

    print("\n--- IPA contents (first 5 entries) ---")
    with zipfile.ZipFile(IPA_PATH, "r") as z:
        names = z.namelist()
        print(f"Total entries: {len(names)}")
        for n in names[:5]:
            print(f"  {n}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
