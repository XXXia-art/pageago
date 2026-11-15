"""Explicitly synthetic intervals for the ActivityWatch-inspired local prototype."""

DATE = "2026-11-03"

PAGES = {
    "attention": ("Attention Is All You Need", "https://arxiv.org/abs/1706.03762"),
    "vit": ("An Image is Worth 16x16 Words", "https://arxiv.org/abs/2010.11929"),
    "clip": ("Learning Transferable Visual Models From Natural Language Supervision", "https://arxiv.org/abs/2103.00020"),
    "qwen": ("Qwen3-VL · 模型代码与使用示例", "https://github.com/QwenLM/Qwen3-VL"),
    "openvla": ("OpenVLA · 视觉语言动作模型", "https://github.com/openvla/openvla"),
    "transformers": ("Transformers · 多模态模型实现", "https://github.com/huggingface/transformers"),
    "flash": ("FlashAttention · 注意力计算实现", "https://github.com/Dao-AILab/flash-attention"),
    "issues": ("Qwen3-VL · Issues", "https://github.com/QwenLM/Qwen3-VL/issues"),
    "readme": ("OpenVLA · 实验配置与运行说明", "https://github.com/openvla/openvla#readme"),
    "hf-model": ("Qwen3-VL · 模型列表", "https://huggingface.co/models?search=Qwen3-VL"),
    "hf-doc": ("Transformers · 模型文档", "https://huggingface.co/docs/transformers/index"),
    "hf-demo": ("视觉语言模型 · 在线演示", "https://huggingface.co/spaces?search=vision%20language"),
    "chat-attention": ("Attention mask 与注意力分数", "https://chatgpt.com/?demo=attention"),
    "chat-icl": ("上下文学习与示例检索", "https://chatgpt.com/?demo=icl"),
    "chat-review": ("整理实验问题与下一步计划", "https://chatgpt.com/?demo=review"),
    "search-vla": ("VLA in-context learning · 搜索", "https://www.bing.com/search?q=VLA+in+context+learning"),
    "search-vit": ("Vision Transformer · 搜索", "https://www.bing.com/search?q=vision+transformer"),
    "search-attention": ("Attention score · 搜索", "https://www.bing.com/search?q=attention+score"),
    "search-edge": ("Edge extension · 搜索", "https://www.bing.com/search?q=edge+extension"),
    "bili-vlm": ("视觉语言模型入门", "https://search.bilibili.com/all?keyword=视觉语言模型"),
    "bili-vit": ("ViT 论文与代码讲解", "https://search.bilibili.com/all?keyword=ViT论文"),
    "bili-icl": ("In-context learning 实践", "https://search.bilibili.com/all?keyword=in-context-learning"),
    "youtube-attention": ("Attention 机制可视化", "https://www.youtube.com/results?search_query=attention+visualized"),
    "youtube-vla": ("视觉语言动作模型演示", "https://www.youtube.com/results?search_query=vision+language+action"),
    "zhihu": ("多模态学习 · 问题与讨论", "https://www.zhihu.com/search?type=content&q=多模态学习"),
    "notes-reading": ("论文阅读笔记", "https://www.feishu.cn/?demo=reading-notes"),
    "notes-plan": ("实验记录与待办", "https://www.feishu.cn/?demo=experiment-notes"),
}

SCHEDULE = [
    ("06:40", "06:47", "search-vla"), ("07:03", "07:18", "zhihu"),
    ("08:12", "08:46", "attention"), ("08:46", "09:02", "qwen"),
    ("09:02", "09:28", "clip"), ("09:28", "09:43", "hf-model"),
    ("09:43", "10:08", "qwen"), ("10:08", "10:18", "chat-attention"),
    ("10:18", "10:42", "vit"), ("10:42", "11:06", "openvla"),
    ("11:06", "11:18", "hf-doc"), ("11:18", "11:39", "transformers"),
    ("11:39", "11:53", "attention"), ("12:05", "12:09", "search-vit"),
    ("12:09", "12:42", "bili-vlm"), ("12:42", "12:56", "bili-vit"),
    ("13:15", "13:31", "hf-demo"), ("13:31", "14:03", "flash"),
    ("14:03", "14:20", "vit"), ("14:20", "14:36", "notes-reading"),
    ("14:36", "15:02", "qwen"), ("15:02", "15:16", "chat-icl"),
    ("15:16", "15:28", "search-attention"), ("15:28", "15:56", "transformers"),
    ("15:56", "16:21", "hf-model"), ("16:21", "16:38", "openvla"),
    ("16:38", "16:58", "clip"), ("17:10", "17:42", "notes-plan"),
    ("17:42", "17:57", "search-edge"), ("19:08", "19:38", "youtube-attention"),
    ("19:38", "20:14", "youtube-vla"), ("20:14", "20:26", "chat-review"),
    ("20:26", "20:48", "issues"), ("20:48", "21:12", "notes-reading"),
    ("21:12", "21:36", "bili-icl"), ("21:36", "21:49", "zhihu"),
    ("22:10", "22:32", "readme"), ("22:32", "22:48", "attention"),
    ("23:02", "23:12", "notes-plan"), ("23:25:00", "23:25:40", "search-vla"),
]


def make_demo():
    return {
        "schema": "daytrace.activity.v1",
        "date": DATE,
        "utc_offset": "+08:00",
        "source": "synthetic",
        "time_basis": "foreground_intervals",
        "description": "全部为合成示例区间。标题和网址用于界面演示，不代表真实访问、阅读或学习。",
        "sessions": [
            {
                "id": f"demo-{i:03d}",
                "title": PAGES[page][0],
                "url": PAGES[page][1],
                "start": f"{DATE}T{start if len(start) > 5 else start + ':00'}+08:00",
                "end": f"{DATE}T{end if len(end) > 5 else end + ':00'}+08:00",
                "profile": "示例",
            }
            for i, (start, end, page) in enumerate(SCHEDULE, 1)
        ],
    }
