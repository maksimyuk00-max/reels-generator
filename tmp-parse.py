import re
with open('C:/claude code/reels-generator/tmp-caption-screen.xml', encoding='utf-8') as f:
    xml = f.read()

# Top area (y < 500) — caption usually top of share screen
print("=== Top area (y<500) clickable or with text ===")
for m in re.finditer(r'<node\s+([^>]*)>', xml):
    attrs = m.group(1)
    b = re.search(r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', attrs)
    if not b: continue
    x1,y1,x2,y2 = map(int, b.groups())
    if y1 >= 500: continue
    rid = re.search(r'resource-id="([^"]*)"', attrs)
    desc = re.search(r'content-desc="([^"]*)"', attrs)
    hint = re.search(r'hint="([^"]*)"', attrs)
    text = re.search(r'text="([^"]*)"', attrs)
    cls = re.search(r'class="([^"]*)"', attrs)
    clk = re.search(r'clickable="([^"]*)"', attrs)
    rid = rid.group(1) if rid else ''
    desc = desc.group(1) if desc else ''
    hint = hint.group(1) if hint else ''
    text = text.group(1) if text else ''
    cls = (cls.group(1) if cls else '').split('.')[-1]
    clk = clk.group(1) if clk else ''
    if rid.startswith('com.instagram') and (text or hint or desc or clk == 'true'):
        print(f"  [{x1},{y1}][{x2},{y2}] cls={cls} rid={rid!r} text={text!r} hint={hint!r} desc={desc!r} clk={clk}")
