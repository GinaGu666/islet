#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把 Claude.ai 导出的 conversations.json（可能上百 MB、包含全部对话）拆开，
挑出属于某个角色的那几段，生成一个精简文件给 islet 导入。全程本地运行，不联网。

用法（在 conversations.json 所在目录打开终端）：

  1. 先列出所有对话，找到属于这个角色的几段：
       python3 split_claude_export.py conversations.json list
       python3 split_claude_export.py conversations.json list --grep Nico      # 只看标题或开头含关键词的
       python3 split_claude_export.py conversations.json list --min-msgs 50    # 只看 50 条以上的长对话

  2. 看某一段的开头几条，确认是不是接着上一段的压缩摘要：
       python3 split_claude_export.py conversations.json show 12 --head 3
     一段超长对话里压缩摘要藏在中间的话，先列出最长的几条消息，再按消息编号看全文：
       python3 split_claude_export.py conversations.json longest 178 --n 15
       python3 split_claude_export.py conversations.json msg 178 5021

  3. 把选中的几段抽出来（编号来自 list 那一列 #）：
       python3 split_claude_export.py conversations.json extract 3 7 12 --name Nico --out nico.json
       python3 split_claude_export.py conversations.json extract --grep Nico --name Nico --out nico.json
     加 --txt 会同时为每段生成一个可读的 .txt，方便自己翻。
     加 --summary-msgs 5021,9870 可以把指定编号的消息标记为压缩摘要（编号来自 longest / msg）。
     加 --with-attachments 会把附件里提取出的文字也带上（默认只留一句「[附件：文件名]」占位）。

输出的 nico.json 是 islet 的导入格式（app = "islet-import"），里面只有你选中的对话，
外加每段开头的第一条用户消息（通常就是上一段的压缩摘要）单独列出来，方便导入时直接进大事记。
"""
import argparse, json, os, re, sys
from datetime import datetime, timezone

def load(path):
    size = os.path.getsize(path)
    print(f"读取 {path}（{size/1048576:.1f} MB）……", file=sys.stderr, flush=True)
    with open(path, 'r', encoding='utf-8') as f:
        data = json.load(f)
    if isinstance(data, dict):
        # 个别版本外面还包一层
        for k in ('conversations', 'data', 'items'):
            if isinstance(data.get(k), list):
                data = data[k]; break
    if not isinstance(data, list):
        sys.exit("看不懂这个文件的结构：最外层不是对话列表。把文件开头 1500 个字符发给我看一下。")
    print(f"共 {len(data)} 段对话", file=sys.stderr)
    return data

def ts_ms(s):
    """ISO 时间字符串 → 毫秒时间戳；解析不了返回 None"""
    if not s or not isinstance(s, str): return None
    s = s.strip().replace('Z', '+00:00')
    s = re.sub(r'(\.\d{3})\d+', r'\1', s)   # 微秒截成毫秒，fromisoformat 老版本不认 7 位
    try:
        d = datetime.fromisoformat(s)
        if d.tzinfo is None: d = d.replace(tzinfo=timezone.utc)
        return int(d.timestamp() * 1000)
    except Exception:
        return None

def fmt_day(ms):
    if not ms: return '????-??-??'
    return datetime.fromtimestamp(ms / 1000).strftime('%Y-%m-%d')

def msg_role(m):
    s = str(m.get('sender') or m.get('role') or '').lower()
    if s in ('human', 'user'): return 'user'
    if s in ('assistant', 'ai', 'claude'): return 'assistant'
    return None

def msg_text(m, with_attachments=False):
    parts = []
    t = m.get('text')
    if isinstance(t, str) and t.strip():
        parts.append(t)
    else:
        for c in (m.get('content') or []):
            if isinstance(c, dict) and c.get('type') == 'text' and isinstance(c.get('text'), str):
                parts.append(c['text'])
    for a in (m.get('attachments') or []):
        if not isinstance(a, dict): continue
        name = a.get('file_name') or a.get('name') or '附件'
        ex = a.get('extracted_content')
        if with_attachments and isinstance(ex, str) and ex.strip():
            parts.append(f"[附件：{name}]\n{ex}")
        else:
            parts.append(f"[附件：{name}]")
    for fobj in (m.get('files') or []):
        if isinstance(fobj, dict):
            parts.append(f"[文件：{fobj.get('file_name') or fobj.get('name') or '文件'}]")
    return '\n'.join(p for p in parts if p).strip()

def conv_messages(c, with_attachments=False):
    out = []
    for m in (c.get('chat_messages') or c.get('messages') or []):
        if not isinstance(m, dict): continue
        role = msg_role(m)
        if not role: continue
        text = msg_text(m, with_attachments)
        if not text: continue
        out.append({'role': role, 'content': text, 'ts': ts_ms(m.get('created_at'))})
    # 按时间排一下（导出通常已有序，保险）
    if all(x['ts'] for x in out):
        out.sort(key=lambda x: x['ts'])
    return out

def summarize(c, i):
    msgs = conv_messages(c)
    chars = sum(len(m['content']) for m in msgs)
    first_user = next((m['content'] for m in msgs if m['role'] == 'user'), '')
    created = ts_ms(c.get('created_at')) or (msgs[0]['ts'] if msgs else None)
    updated = ts_ms(c.get('updated_at')) or (msgs[-1]['ts'] if msgs else None)
    return {
        'i': i, 'uuid': c.get('uuid') or c.get('id') or '', 'title': (c.get('name') or c.get('title') or '（无标题）').strip(),
        'created': created, 'updated': updated, 'n': len(msgs), 'chars': chars,
        'preview': re.sub(r'\s+', ' ', first_user)[:60],
    }

def matches(s, grep):
    if not grep: return True
    g = grep.lower()
    return g in s['title'].lower() or g in s['preview'].lower()

def cmd_list(data, args):
    rows = [summarize(c, i) for i, c in enumerate(data)]
    rows = [r for r in rows if r['n'] >= args.min_msgs and matches(r, args.grep)]
    rows.sort(key=lambda r: r['created'] or 0)
    print(f"{'#':>5}  {'开始日期':<10}  {'条数':>5}  {'字数':>8}  标题 ｜ 开头预览")
    for r in rows:
        print(f"{r['i']:>5}  {fmt_day(r['created']):<10}  {r['n']:>5}  {r['chars']:>8}  {r['title'][:28]} ｜ {r['preview']}")
    total = sum(r['chars'] for r in rows)
    print(f"\n{len(rows)} 段，合计约 {total/10000:.1f} 万字。", file=sys.stderr)

def cmd_show(data, args):
    c = data[args.index]
    s = summarize(c, args.index)
    msgs = conv_messages(c)
    print(f"# {s['title']}   {fmt_day(s['created'])} → {fmt_day(s['updated'])}   {s['n']} 条 / {s['chars']} 字\n")
    for m in msgs[:args.head]:
        who = '用户' if m['role'] == 'user' else 'AI'
        body = m['content'] if len(m['content']) <= args.chars else m['content'][:args.chars] + f"\n……（共 {len(m['content'])} 字）"
        print(f"—— {who} · {fmt_day(m['ts'])} ——\n{body}\n")

def cmd_longest(data, args):
    c = data[args.index]
    msgs = conv_messages(c)
    order = sorted(range(len(msgs)), key=lambda i: -len(msgs[i]['content']))[:args.n]
    print(f"# {summarize(c, args.index)['title']}：最长的 {len(order)} 条消息（编号 = 该对话内的消息序号，用 msg 命令看全文）\n")
    print(f"{'编号':>6}  {'日期':<10}  {'谁':<3}  {'字数':>7}  开头")
    for i in sorted(order):
        m = msgs[i]
        print(f"{i:>6}  {fmt_day(m['ts']):<10}  {'用户' if m['role']=='user' else 'AI':<3}  {len(m['content']):>7}  {re.sub(chr(10)+'|'+chr(13), ' ', m['content'])[:70]}")

def cmd_msg(data, args):
    c = data[args.index]
    msgs = conv_messages(c)
    for k in args.msg_indices:
        if k < 0 or k >= len(msgs): print(f"没有编号 {k}（共 {len(msgs)} 条）"); continue
        m = msgs[k]
        print(f"—— #{k} · {'用户' if m['role']=='user' else 'AI'} · {fmt_day(m['ts'])} · {len(m['content'])} 字 ——\n{m['content']}\n")

def cmd_extract(data, args):
    idx = list(args.indices)
    if args.grep:
        idx += [i for i, c in enumerate(data) if matches(summarize(c, i), args.grep)]
    idx = sorted(set(idx))
    if not idx: sys.exit("没有选中任何对话：给编号，或用 --grep 关键词")
    convs, summaries = [], []
    for i in idx:
        c = data[i]; s = summarize(c, i)
        msgs = conv_messages(c, args.with_attachments)
        if not msgs: continue
        convs.append({'title': s['title'], 'uuid': s['uuid'], 'created': s['created'] or msgs[0]['ts'], 'updated': s['updated'] or msgs[-1]['ts'], 'messages': msgs})
        first_user = next((m for m in msgs if m['role'] == 'user'), None)
        if first_user and len(first_user['content']) >= args.summary_min:
            summaries.append({'from': s['title'], 'date': first_user['ts'] or s['created'], 'text': first_user['content']})
        if args.summary_msgs and len(idx) == 1:   # 手动指定的摘要消息（只在抽单段对话时有意义）
            for k in args.summary_msgs:
                if 0 <= k < len(msgs): summaries.append({'from': s['title'], 'date': msgs[k]['ts'] or s['created'], 'text': msgs[k]['content'], 'msgIndex': k})
    seen = set(); summaries = [x for x in summaries if not (x['text'] in seen or seen.add(x['text']))]   # 启发式与手动标记撞上时去重
    summaries.sort(key=lambda x: x['date'] or 0)
    convs.sort(key=lambda c: c['created'] or 0)
    out = {
        'app': 'islet-import', 'version': 1, 'source': 'claude.ai', 'exportedAt': datetime.now(timezone.utc).isoformat(),
        'character': {'name': args.name or '', 'persona': '', 'summaries': summaries},
        'conversations': convs,
    }
    with open(args.out, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, indent=None, separators=(',', ':'))
    total_chars = sum(len(m['content']) for c in convs for m in c['messages'])
    total_msgs = sum(len(c['messages']) for c in convs)
    print(f"\n已写入 {args.out}：{len(convs)} 段对话，{total_msgs} 条消息，约 {total_chars/10000:.1f} 万字，文件 {os.path.getsize(args.out)/1048576:.2f} MB")
    print(f"其中识别出 {len(summaries)} 条「开头长消息」，很可能是上一段的压缩摘要，导入时可直接进大事记。")
    if total_chars * 2 > 4.5 * 1048576:
        print("提醒：原文体量超过手机浏览器本地存储能装下的量（约 5MB）。导入时会只完整保留最近的几段，更早的以摘要和记忆卡形式保存。", file=sys.stderr)
    if args.txt:
        base = os.path.splitext(args.out)[0]
        for k, c in enumerate(convs, 1):
            safe = re.sub(r'[^\w\u4e00-\u9fff-]+', '_', c['title'])[:30]
            p = f"{base}-{k:02d}-{safe}.txt"
            with open(p, 'w', encoding='utf-8') as f:
                f.write(f"# {c['title']}\n{fmt_day(c['created'])} → {fmt_day(c['updated'])}\n\n")
                for m in c['messages']:
                    f.write(f"【{'用户' if m['role']=='user' else 'AI'} · {fmt_day(m['ts'])}】\n{m['content']}\n\n")
        print(f"另有 {len(convs)} 个 .txt 写在 {base}-*.txt")

def main():
    ap = argparse.ArgumentParser(description='拆分 Claude.ai 导出的 conversations.json，抽出某个角色的对话给 islet 导入')
    ap.add_argument('file', help='conversations.json 路径')
    sub = ap.add_subparsers(dest='cmd', required=True)
    p = sub.add_parser('list', help='列出所有对话'); p.add_argument('--grep', help='只列标题或开头含此关键词的'); p.add_argument('--min-msgs', type=int, default=1, help='只列至少这么多条消息的')
    p = sub.add_parser('show', help='看某段对话的开头'); p.add_argument('index', type=int); p.add_argument('--head', type=int, default=3, help='显示前几条'); p.add_argument('--chars', type=int, default=1200, help='每条最多显示多少字')
    p = sub.add_parser('longest', help='列出某段对话里最长的几条消息（找压缩摘要用）'); p.add_argument('index', type=int); p.add_argument('--n', type=int, default=15)
    p = sub.add_parser('msg', help='按消息编号看全文'); p.add_argument('index', type=int); p.add_argument('msg_indices', type=int, nargs='+')
    p = sub.add_parser('extract', help='抽出选中的对话'); p.add_argument('indices', type=int, nargs='*', help='list 里的 # 编号'); p.add_argument('--grep', help='选中标题或开头含此关键词的全部对话'); p.add_argument('--name', help='角色名字，写进导入文件'); p.add_argument('--out', default='islet-import.json'); p.add_argument('--txt', action='store_true', help='同时输出每段的 .txt'); p.add_argument('--with-attachments', action='store_true', help='带上附件里提取的文字'); p.add_argument('--summary-min', type=int, default=800, help='开头第一条用户消息至少多长才算压缩摘要（字数）'); p.add_argument('--summary-msgs', type=lambda v: [int(x) for x in v.split(',') if x.strip()], help='手动标记为压缩摘要的消息编号，逗号分隔')
    args = ap.parse_args()
    data = load(args.file)
    {'list': cmd_list, 'show': cmd_show, 'longest': cmd_longest, 'msg': cmd_msg, 'extract': cmd_extract}[args.cmd](data, args)

if __name__ == '__main__':
    main()
