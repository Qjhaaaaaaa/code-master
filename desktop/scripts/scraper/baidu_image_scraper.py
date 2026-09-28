# 百度图片批量下载脚本（增强反爬版）
# 使用百度图片AJAX API接口，支持UA轮换、随机延迟、重试机制

import urllib.request
import urllib.parse
import ssl
import os
import re
import json
import sys
import time
import random
import hashlib

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

# 多个User-Agent轮换，模拟不同浏览器
USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36 Edg/123.0.0.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
]


def get_random_ua():
    return random.choice(USER_AGENTS)


def random_delay(min_s=0.5, max_s=2.0):
    """随机延迟，模拟人类行为"""
    time.sleep(random.uniform(min_s, max_s))


def search_baidu_images(keyword, count=100):
    """百度图片AJAX接口 - 增强反爬版"""
    image_urls = []
    page = 0
    per_page = 30
    max_pages = 20
    consecutive_fails = 0

    while len(image_urls) < count and page < max_pages:
        # 每次请求使用不同的UA
        ua = get_random_ua()
        headers = {
            "User-Agent": ua,
            "Accept": "application/json, text/javascript, */*; q=0.01",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
            "Referer": "https://image.baidu.com/",
            "X-Requested-With": "XMLHttpRequest",
            "Connection": "keep-alive",
        }

        # 添加随机参数防指纹
        params = urllib.parse.urlencode({
            "tn": "resultjson_com",
            "logid": hashlib.md5(str(time.time()).encode()).hexdigest()[:16],
            "ipn": "rj",
            "ct": "201326592",
            "is": "",
            "fp": "result",
            "fr": "",
            "word": keyword,
            "queryWord": keyword,
            "cl": "2",
            "lm": "-1",
            "ie": "utf-8",
            "oe": "utf-8",
            "adpicid": "",
            "st": "-1",
            "z": "",
            "ic": "",
            "hd": "",
            "latest": "",
            "copyright": "",
            "s": "",
            "se": "",
            "tab": "",
            "width": "",
            "height": "",
            "face": "0",
            "istype": "2",
            "qc": "",
            "nc": "1",
            "expermode": "",
            "nojc": "",
            "isAsync": "",
            "pn": page * per_page,
            "rn": per_page,
            "gsm": hex(page * per_page)[2:],
        })
        url = f"https://image.baidu.com/search/acjson?{params}"

        try:
            req = urllib.request.Request(url, headers=headers)
            resp = urllib.request.urlopen(req, timeout=20, context=ctx)
            data = resp.read().decode("utf-8", errors="ignore")

            # 检查是否被反爬拦截
            if len(data) < 50 or "error" in data.lower()[:100]:
                print(f"  第{page+1}页: 可能被拦截，等待后重试...")
                consecutive_fails += 1
                if consecutive_fails >= 3:
                    print("  连续3次失败，延长等待...")
                    time.sleep(random.uniform(5, 10))
                    consecutive_fails = 0
                page += 1
                continue

            # 尝试解析JSON
            try:
                result = json.loads(data)
                items = result.get("data", [])
                for item in items:
                    if not item or not isinstance(item, dict):
                        continue
                    # 优先取高清URL
                    for key in ["objURL", "hoverURL", "thumbURL", "middleURL"]:
                        img_url = item.get(key, "")
                        if img_url and img_url.startswith("http"):
                            if img_url not in image_urls:
                                image_urls.append(img_url)
                            break
            except json.JSONDecodeError:
                # JSON解析失败，用正则提取
                urls = re.findall(r'"objURL"\s*:\s*"(https?://[^"]+)"', data)
                urls += re.findall(r'"hoverURL"\s*:\s*"(https?://[^"]+)"', data)
                urls += re.findall(r'"thumbURL"\s*:\s*"(https?://[^"]+)"', data)
                for u in urls:
                    u = u.replace("\\/", "/")
                    if u not in image_urls:
                        image_urls.append(u)

            consecutive_fails = 0
            print(f"  第{page+1}页: 累计收集 {len(image_urls)} 个图片URL")

        except Exception as e:
            consecutive_fails += 1
            print(f"  第{page+1}页失败: {e}")
            if consecutive_fails >= 3:
                print("  连续失败，等待较长时间后重试...")
                time.sleep(random.uniform(8, 15))
                consecutive_fails = 0

        page += 1
        # 随机延迟，避免固定节奏
        random_delay(0.8, 2.5)

    return image_urls[:count]


def download_image(url, save_path, timeout=15):
    """下载单张图片 - 带重试"""
    max_retries = 3
    for attempt in range(max_retries):
        try:
            req = urllib.request.Request(url, headers={
                "User-Agent": get_random_ua(),
                "Referer": "https://image.baidu.com/",
                "Accept": "image/webp,image/apng,image/*,*/*;q=0.8",
            })
            data = urllib.request.urlopen(req, timeout=timeout, context=ctx).read()

            if len(data) < 3000:
                return False, "文件太小"

            with open(save_path, "wb") as f:
                f.write(data)
            return True, len(data)

        except Exception as e:
            if attempt < max_retries - 1:
                time.sleep(random.uniform(1, 3))
            else:
                return False, str(e)

    return False, "重试次数用尽"


def main():
    keyword = "女生比基尼"
    target_count = 100
    save_dir = os.path.join(os.path.expanduser("~"), "Desktop", "bikini_images")

    if len(sys.argv) >= 2:
        keyword = sys.argv[1]
    if len(sys.argv) >= 3:
        target_count = int(sys.argv[2])
    if len(sys.argv) >= 4:
        save_dir = sys.argv[3]

    os.makedirs(save_dir, exist_ok=True)

    print(f"关键词: {keyword}")
    print(f"目标数量: {target_count}")
    print(f"保存目录: {save_dir}")
    print(f"反爬策略: UA轮换({len(USER_AGENTS)}个) + 随机延迟 + 重试机制")
    print()

    # 搜索图片URL
    print("[1/2] 从百度图片搜索...")
    urls = search_baidu_images(keyword, target_count * 3)
    print(f"\n共找到 {len(urls)} 个图片URL\n")

    if not urls:
        print("未找到图片")
        return

    # 下载图片
    print("[2/2] 开始下载图片...")
    success_count = 0
    fail_count = 0

    for i, url in enumerate(urls):
        if success_count >= target_count:
            break

        ext = ".jpg"
        if ".png" in url.lower():
            ext = ".png"
        elif ".webp" in url.lower():
            ext = ".webp"
        elif ".gif" in url.lower():
            ext = ".gif"

        filename = f"img_{success_count + 1:03d}{ext}"
        save_path = os.path.join(save_dir, filename)

        ok, info = download_image(url, save_path)
        if ok:
            success_count += 1
            print(f"  OK [{success_count}/{target_count}] {filename} ({info} bytes)")
        else:
            fail_count += 1
            if os.path.exists(save_path):
                os.remove(save_path)

        # 下载间隔随机延迟
        random_delay(0.2, 0.8)

    print(f"\n{'='*50}")
    print(f"下载完成! 成功: {success_count}, 失败: {fail_count}")
    print(f"保存目录: {save_dir}")
    print(f"{'='*50}")


if __name__ == "__main__":
    main()
