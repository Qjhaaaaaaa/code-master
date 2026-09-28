#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
文件整理脚本：根据文件扩展名将桌面文件分类到不同文件夹中。
"""

import os
import shutil
import sys

def organize_files(source_dir, target_dirs):
    """
    将源目录中的文件按扩展名移动到目标目录。
    
    Args:
        source_dir (str): 源目录路径
        target_dirs (dict): 目标目录字典，键为扩展名（如'.pdf'），值为目标目录路径
    """
    if not os.path.exists(source_dir):
        print(f"错误：源目录不存在 {source_dir}")
        return
    
    # 获取所有文件
    files = [f for f in os.listdir(source_dir) if os.path.isfile(os.path.join(source_dir, f))]
    
    for file_name in files:
        file_path = os.path.join(source_dir, file_name)
        _, ext = os.path.splitext(file_name)
        
        # 查找匹配的目录
        target_dir = None
        for pattern, dir_path in target_dirs.items():
            if ext.lower() == pattern.lower():
                target_dir = dir_path
                break
        
        if target_dir:
            # 创建目标目录（如果不存在）
            os.makedirs(target_dir, exist_ok=True)
            
            # 移动文件
            try:
                shutil.move(file_path, os.path.join(target_dir, file_name))
                print(f"已移动: {file_name} -> {target_dir}")
            except Exception as e:
                print(f"移动失败 {file_name}: {e}")
        else:
            # 未匹配的文件，可以放在“其他”目录
            other_dir = os.path.join(source_dir, "其他")
            os.makedirs(other_dir, exist_ok=True)
            try:
                shutil.move(file_path, os.path.join(other_dir, file_name))
                print(f"已移动到其他: {file_name}")
            except Exception as e:
                print(f"移动失败 {file_name} 到其他目录: {e}")

if __name__ == "__main__":
    desktop_path = r"C:\Users\Qjhaaaa\Desktop"
    
    # 定义分类规则
    categories = {
        ".pdf": os.path.join(desktop_path, "PDF文件"),
        ".docx": os.path.join(desktop_path, "Word文档"),
        ".lnk": os.path.join(desktop_path, "快捷方式"),
        ".url": os.path.join(desktop_path, "网址链接"),
        ".txt": os.path.join(desktop_path, "文本文件"),
        ".csv": os.path.join(desktop_path, "数据文件"),
        ".jpg": os.path.join(desktop_path, "图片"),
        ".png": os.path.join(desktop_path, "图片"),
        ".exe": os.path.join(desktop_path, "可执行文件"),
    }
    
    organize_files(desktop_path, categories)
    print("文件整理完成！")