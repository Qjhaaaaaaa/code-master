# Pexels图片批量下载脚本（免费可商用图片）
# 使用Pexels公开页面抓取图片URL

import urllib.request
import urllib.parse
import ssl
import os
import re
import sys
import time

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}


def search_pexels(keyword, count=100):
    """从Pexels搜索图片"""
    image_urls = []
    page = 1

    while len(image_urls) < count and page <= 20:
        encoded = urllib.parse.quote(keyword)
        url = f"https://www.pexels.com/search/{encoded}/?page={page}"

        try:
            req = urllib.request.Request(url, headers=HEADERS)
            resp = urllib.request.urlopen(req, timeout=20, context=ctx)
            html = resp.read().decode("utf-8", errors="ignore")

            # Pexels图片URL格式: images.pexels.com/photos/xxx/pexels-photo-xxx.jpeg
            urls = re.findall(r'(https://images\.pexels\.com/photos/\d+/[^"\'?\s]+)', html)
            # 去重
            seen = set()
            for u in urls:
                # 取大图版本
                u = re.sub(r'\?[^"]*', '', u)
                if u not in seen:
                    seen.add(u)
                    image_urls.append(u)

            print(f"  第{page}页: 累计收集 {len(image_urls)} 个图片URL")

        except Exception as e:
            print(f"  第{page}页失败: {e}")

        page += 1
        time.sleep(1.5)

    return image_urls[:count]


def search_pixabay(keyword, count=100):
    """从Pixabay搜索图片（备用方案）"""
    image_urls = []
    page = 1

    while len(image_urls) < count and page <= 10:
        encoded = urllib.parse.quote(keyword)
        url = f"https://pixabay.com/images/search/{encoded}/?pagi={page}"

        try:
            req = urllib.request.Request(url, headers=HEADERS)
            resp = urllib.request.urlopen(req, timeout=20, context=ctx)
            html = resp.read().decode("utf-8", errors="ignore")

            # Pixabay图片URL
            urls = re.findall(r'(https://cdn\.pixabay\.com/photo/[^"\'?\s]+)', html)
            seen = set()
            for u in urls:
                u = u.split("?")[0]
                if u not in seen:
                    seen.add(u)
                    image_urls.append(u)

            print(f"  第{page}页: 累计收集 {len(image_urls)} 个图片URL")

        except Exception as e:
            print(f"  第{page}页失败: {e}")

        page += 1
        time.sleep(1.5)

    return image_urls[:count]


def download_image(url, save_path, timeout=15):
    """下载单张图片"""
    try:
        req = urllib.request.Request(url, headers=HEADERS)
        data = urllib.request.urlopen(req, timeout=timeout, context=ctx).read()

        if len(data) < 5000:
            return False, "文件太小"

        with open(save_path, "wb") as f:
            f.write(data)
        return True, len(data)

    except Exception as e:
        return False, str(e)


def main():
    keyword = "bikini beach beautiful"
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
    print()

    # 先尝试Pexels
    print("[1] 尝试从Pexels搜索...")
    urls = search_pexels(keyword, target_count * 2)

    # 不够的话尝试Pixabay
    if len(urls) < target_count:
        print(f"\n[2] Pexels只找到{len(urls)}个，尝试Pixabay...")
        urls2 = search_pixabay(keyword, target_count * 2)
        urls.extend(urls2)

    # 去重
    seen = set()
    unique_urls = []
    for u in urls:
        if u not in seen:
            seen.add(u)
            unique_urls.append(u)
    urls = unique_urls

    print(f"\n共找到 {len(urls)} 个图片URL")

    if not urls:
        print("未找到图片，请检查网络")
        return

    # 下载
    print(f"\n开始下载图片...")
    success_count = 0
    fail_count = 0

    for i, url in enumerate(urls):
        if success_count >= target_count:
            break

        ext = ".jpg"
        if ".png" in url.lower():
            ext = ".png"

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

        time.sleep(0.2)

    print(f"\n下载完成! 成功: {success_count}, 失败: {fail_count}")
    print(f"保存目录: {save_dir}")


if __name__ == "__main__":
    main()
