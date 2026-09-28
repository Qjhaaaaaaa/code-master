import urllib.request
import ssl
import os

# 跳过SSL验证
ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

urls = [
    ("https://upload.wikimedia.org/wikipedia/commons/thumb/9/97/Florida_Box_Turtle_Digon3.jpg/640px-Florida_Box_Turtle_Digon3.jpg", "turtle_wiki.jpg"),
    ("https://upload.wikimedia.org/wikipedia/commons/thumb/4/42/Turtle_in_Ras_Muhammad.JPG/640px-Turtle_in_Ras_Muhammad.JPG", "turtle_sea.jpg"),
    ("https://upload.wikimedia.org/wikipedia/commons/thumb/8/80/Turtle_garden.jpg/640px-Turtle_garden.jpg", "turtle_garden.jpg"),
]

desktop = os.path.join(os.path.expanduser("~"), "Desktop")

for url, name in urls:
    try:
        out = os.path.join(desktop, name)
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        data = urllib.request.urlopen(req, timeout=15, context=ctx).read()
        with open(out, "wb") as f:
            f.write(data)
        print(f"OK: {name} ({len(data)} bytes)")
        break
    except Exception as e:
        print(f"FAIL {name}: {e}")
