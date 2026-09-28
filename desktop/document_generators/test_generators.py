# -*- coding: utf-8 -*-
"""Test script for professional document generators - Qjh resume data."""
import sys, os, json
sys.stdout.reconfigure(encoding='utf-8')

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from pdf_generator import generate_resume, generate_report
from word_generator import generate_resume as word_resume, generate_report as word_report
from ppt_generator import generate_ppt

desktop = os.path.join(os.path.expanduser('~'), 'Desktop')

# ─── Qjh Resume Data (matching reference format) ───────────────
qjh_resume = {
    "title": "覃金洪",
    "name": "覃金洪",
    "birth": "2001.03.06",
    "gender": "男",
    "major": "数据科学与大数据技术",
    "university": "西南大学人工智能学院",
    "graduation_year": "2021.09-2025.06",
    "phone": "18683719479",
    "email": "1772242785@qq.com",
    "location": "成都市双流区",
    "type": "应届生",
    "position": "大模型应用工程师",
    "content": """## 精通技能

Python, Pytorch, Transformer架构, Muti-Agent构建, RAG, React框架, Prompt Engine, 多模态, 大模型训练, 模型微调, Lora, VIT, ASR, SFT, Langchain, LangGraph, NLP, 机器学习, 数据挖掘与分析, 大模型运行, 模型记忆构造, 语音交互

## 项目经历

**项目1：基于Qwen2.5-Coder-1.5b模型的Muti-agent架构设计与Agent全链路优化以及多模态功能的构建**（2025.07-至今）
技术栈：transformers, pytorch, peft, chromadb, sentenceTransformer, pandas, face_recognition, aip, OCR, dashscope, base64, trainer
项目背景：基于Qwen2.5设计Muti-agent架构，赋予模型记忆能力，人脸识别能力，语音识别能力，语音交互能力，审核视频能力，包括识别视频是否违规，识别视频里字幕或出现的文字是否违规，识别视频语音是否违规等。
主要工作：
1. 使用LoRA技术微调Qwen2.5-Coder-1.5B，降低模型幻觉，增强模型回复能力，采用4bit量化提升模型推理速度，压缩体积从3.3GB到1GB，推理速度从30秒提升至1秒。
2. 注入工具，基于face_recognition等库实现模型人脸识别能力,精确率大于85%。
3. 基于trainer对大批量对话数据集训练，得到lora权重合并模型加速推理，显著提升模型交流能力。
4. 基于aip以及语音解析工具，实现模型语音交互能力。
5. 编写工具动态注册，实现模型审核视频技术，对上传视频审核是否违规。
6. 动态注册工具分析视频流语音是否违规。
7. 设计功能实现模型对视频文字内容的提取及判断是否违规。

**项目2：基于Npm泄露的map文件完成Claude Code闭源agent编程代理的逆向重建与多模型适配**（2026.03.31-至今）
技术栈：node-pty, Docker, API, LiteLLM, bun, powershell, cmd, claude-code, github, ollama, npm, anthropic
项目背景：基于Source Map泄露的Claude Code源码复原与多模型工具链可用性复现
主要工作：
1. 定位NPM包中意外暴露的Source Map文件，通过解析其sourcesContent字段与映射关系，将打包混淆后的Webpack产物逆向还原为具备完整目录结构的JavaScript源码，覆盖约1900余个源文件。
2. 手工补全原构建流程中缺失的JSON配置文件包括工具定义Schema、Agent配置项、依赖声明等，修复模块路径与运行时符号引用，使复原代码脱离NPM原始发布包独立运行，并通过完整性校验。
3. 搭建最小化本地调试环境，对Agent主循环、模型API调用链路、Tool Use消息拼接逻辑进行端到端验证，确认文件读写、Bash执行、代码搜索功能等。
4. 基于复原源码抽象模型适配层，实现对OpenAI、DeepSeek等非原生模型接口的兼容，能调用除Anthroptic接口之外的模型。

**项目3：多模型机器学习分类实践**（2022.09-至今）
技术栈：Python, Scikit-learn, Pandas, Matplotlib, KNN, 随机森林，逻辑回归，线性回归, SVM, 决策树, 朴素贝叶斯
项目背景：通过数据挖掘，数据分析，针对多种数据集进行分类实验，比较不同机器学习模型的泛化能力。
主要工作：基于pandas等包对数据进行清洗，采用特征工程（标准化、PCA降维）、超参数优化、模型评估验证（交叉验证、F1-score、ROC曲线、热力图），并分析模型优点，提升模型各项指标（准确率，精确率，召回率）。

**项目4：Python爬虫与QQ机器人**（2022.09-2024.06）
技术栈：Python, Request, HTML, JavaScript, Fillder, Opencv, numpy, pandas, Regex, pytorch, postman, Mysql
项目背景：分析HTML源码，JS源码，抓包分析参数，伪造请求头，基于Request爬取网站数据，突破反爬破解网页限制。
主要工作：
1. 基于fillder连接手机端口抓包，潜入钉钉打卡系统，爬取学生身份信息。
2. 分析JS源码，突破网页有道翻译的反爬，采用JS逆向技术实现有道翻译的功能。
3. 基于正则表达式以及request等包分析网页特征，伪造请求头，爬取超量京东商品的信息。
4. 爬取大批量网站的图片。
5. 基于Opencv等包实现qq机器人，实现对话以及多种qq功能。

## 综合能力

**大模型：**有一年以上大模型研发经验，掌握LLM, ReAct模式, Multi-Agent, 嵌入式模型, 语音识别集成, prompt工程, LoRA微调, 4bit量化技术，基于Trainer的大模型训练，chromadb, AutoTokenizer，具备Qwen系列模型优化经验，实现多模态的经验掌握大模型运营，熟悉大模型审核视频工作流以及技术应用，熟练掌握OCR文字识别技术以及语音识别技术。"""
}

# ─── Run Tests ──────────────────────────────────────────────────
print("=" * 60)
print("Testing Qjh Resume Format")
print("=" * 60)

# Test PDF Resume
print("\n[1/3] Generating PDF Resume...")
try:
    pdf_path = os.path.join(desktop, 'test_qjh_resume.pdf')
    generate_resume(qjh_resume, pdf_path)
    size = os.path.getsize(pdf_path)
    print(f"  OK: {pdf_path} ({size} bytes)")
except Exception as e:
    import traceback
    print(f"  FAILED: {e}")
    traceback.print_exc()

# Test Word Resume
print("\n[2/3] Generating Word Resume...")
try:
    word_path = os.path.join(desktop, 'test_qjh_resume.docx')
    word_resume(qjh_resume, word_path)
    size = os.path.getsize(word_path)
    print(f"  OK: {word_path} ({size} bytes)")
except Exception as e:
    import traceback
    print(f"  FAILED: {e}")
    traceback.print_exc()

# Test PPT
print("\n[3/3] Generating PPT...")
try:
    ppt_data = {
        "title": "大模型应用工程师 - 覃金洪",
        "subtitle": "个人技术能力展示",
        "slides": [
            {"title": "个人简介", "content": "西南大学人工智能学院\n数据科学与大数据技术专业\n一年以上大模型研发经验"},
            {"title": "核心技能", "content": "**大模型**: Qwen, LLM, LoRA, 4bit量化\n**框架**: PyTorch, Transformers, LangChain\n**技术**: Multi-Agent, RAG, Prompt Engineering\n**其他**: Python, Scikit-learn, NLP"},
            {"title": "---项目经验", "content": "", "subtitle": "Project Experience"},
            {"title": "Multi-Agent架构设计", "content": "基于Qwen2.5-Coder-1.5B设计Multi-agent架构\nLoRA微调+4bit量化，推理速度30秒→1秒\n模型体积3.3GB→1GB\n人脸识别精确率>85%"},
            {"title": "Claude Code逆向重建", "content": "基于Source Map逆向还原1900+源文件\n抽象模型适配层兼容OpenAI/DeepSeek\n端到端验证Agent主循环完整功能"},
            {"title": "---综合能力", "content": "", "subtitle": "Core Competencies"},
            {"title": "大模型全栈能力", "content": "掌握LLM全链路: 训练→微调→部署→应用\nReAct模式 + Multi-Agent架构设计\nLoRA/QLoRA微调 + 4bit量化技术\nOCR文字识别 + 语音识别技术"},
        ]
    }
    ppt_path = os.path.join(desktop, 'test_qjh_presentation.pptx')
    generate_ppt(ppt_data, ppt_path)
    size = os.path.getsize(ppt_path)
    print(f"  OK: {ppt_path} ({size} bytes)")
except Exception as e:
    import traceback
    print(f"  FAILED: {e}")
    traceback.print_exc()

# Verify page counts
print("\n" + "=" * 60)
print("Verification:")
print("=" * 60)
try:
    import fitz
    doc = fitz.open(os.path.join(desktop, 'test_qjh_resume.pdf'))
    print(f"  PDF Resume pages: {len(doc)}")
    doc.close()
except Exception as e:
    print(f"  PDF check failed: {e}")

try:
    from docx import Document
    doc = Document(os.path.join(desktop, 'test_qjh_resume.docx'))
    print(f"  Word Resume paragraphs: {len(doc.paragraphs)}")
except Exception as e:
    print(f"  Word check failed: {e}")

print("\nAll tests completed!")
