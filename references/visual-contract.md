# Visual contract

## Contents

1. Narrative order
2. Navigation and date filtering
3. Adaptive date grain
4. Chart contracts
5. Range summary
6. Motion rules
7. Copy rules
8. Responsive and print rules
9. Effects to reject

## Narrative order

Use a warm editorial surface, near-black ink, one electric blue focus color, and one restrained orange exception color. The report should feel like a designed analytical publication rather than a dashboard component gallery. Treat charts and quantitative marks as the primary content; prose only frames how to read them.

Layout rules:

- Keep the desktop cover near 350 px tall and pair the title with one large calculated total.
- Use a restrained sticky publication header with one global date-range control. On desktop, pair it with a narrow Codex-style chapter tick rail at the left edge; on mobile, replace that rail with horizontally scrollable text section anchors in the top header.
- Immediately after the cover, use exactly one four-item official-usage strip: selected-range Token total, average per selected calendar day, single-day peak with date, and active days over selected days. Do not stack a second KPI row above or below it.
- Keep cache share, local reconstruction coverage, project attribution coverage, and official-versus-local gaps out of the opening strip. Place each only in its relevant analysis or methodology section.
- Let the first date chart begin at the edge of the first desktop viewport.
- Give every chapter one short, neutral headline, one data-specific numeric annotation, and then the chart surface.
- Avoid explanatory paragraphs longer than two lines at the 1440 px target.
- Make charts and data marks occupy most of each chapter's visible area.
- Close with a compact selected-range facts summary instead of recommendations or a second text-heavy report section.
- Move methodology and limitations after the visual narrative.

Readability and composition rules:

- Reset every chart `<figure>` to `margin: 0; min-width: 0; width: 100%`. Browser-default figure margins must never reduce the chart surface or inflate a two-column gutter.
- At the 1440 px desktop target, use a 16 px body base, 42 px chapter headings, 18 px chart titles, 13 px chart subtitles, and 12–14 px explanatory copy. ECharts axes and value labels must be at least 10 px; category labels should be 11–12 px.
- At the 390 px mobile target, use 32 px chapter headings, 18 px chart titles, 12 px chart subtitles, 13 px explanatory copy, and 10 px minimum chart axes. Do not solve crowding by shrinking text below this floor; reduce tick count or reorganize the chart.
- Keep a desktop two-chart composition near 7:5 with a true 24 px gutter and at least 520 px for the secondary card. Stack it before the secondary card would become narrower than that target.
- Chart cards use one visual level: clean light surface, clear 1 px boundary, restrained shadow, and 8–12 px radius. Avoid nested card effects inside the chart header.
- Use readable secondary text colors. Axis and annotation text must be visibly darker than grid lines; reserve very faint colors for decorative rules only.
- Interactive controls and disclosure rows must provide a 44 px minimum touch target on mobile.
- Precision tables must align every numeric header to the same right edge as its numeric cells. Mark numeric headers semantically instead of relying on `nth-child`, because each detail table has a different column structure.
- Label the aggregate explicitly as `Token 总量` and preserve the formula `新输入 + 输出 + 缓存读取 + 缓存写入`; do not add reasoning Tokens a second time when the source exposes them as an output subset.

Order:

1. compact cover and large official total;
2. one four-item official-usage strip;
3. official account date activity and cumulative Token chart;
4. locally reconstructed Token composition;
5. locally attributed projects;
6. models and activities;
7. session cost distribution;
8. dated execution-hour rhythm;
9. selected-range facts summary, then methodology and limitations.

## Navigation and date filtering

- Offer full range, recent-range, current/previous-month, and custom inclusive-date choices within the source bounds.
- State the active range beside the global control and keep it available while the reader moves between chapters.
- Apply one selected range to both named layers: filter official buckets by their returned date labels, and filter local detail by local model-call dates. The update must replace every headline, chart, annotation, ranking, precision table, and selected-range fact in one render pass.
- Keep local projects, models, tasks, sessions, hours, Token components, and estimated cost on one compact local fact subset. Do not join or prorate the official-minus-local residual into those views.
- Keep the selected range in the URL when practical so a refined view can be reopened without changing the underlying local snapshot.
- Do not place chart-replay or global-replay controls in the header, chapters, or date panel.
- On desktop, render a slim fixed or sticky chapter rail along the left edge. Use short horizontal ticks: one major tick per chapter, quieter minor ticks between chapters, and a dark longer tick for the active chapter. Give every major tick an accessible chapter name and reveal its text label on focus or hover without covering report content.
- Keep the desktop rail visually separate from charts and reserve enough left gutter that it never obscures axes, tooltips, or body copy. Clicking a major tick scrolls to the corresponding chapter and active state follows the viewport.
- At mobile widths, hide the tick rail completely. Use short Chinese chapter names in a compact top text navigation, keep the row horizontally scrollable, and bring the active item into view without causing document-level horizontal overflow.

## Adaptive date grain

Choose the visible grain from the active inclusive range, not from the full snapshot:

- **1–14 days:** calculate and draw daily values, label every actual local date, and retain zero-call dates so spacing remains truthful. For a one- or two-day session view, show local timestamps and hours where useful.
- **15–92 days:** retain daily values for the daily/cumulative chart, but organize dense comparisons with weekly boundaries, weekly grouping, or weekly major ticks. Tooltips and selected marks must still expose exact local dates.
- **More than 92 days:** use calendar months as the primary visible grain. Mark partial boundary months and retain exact dates in drill-down tables or tooltips when the chart supports them.

The selected grain applies across the whole report. A 7-day selection must not continue to show a monthly Token ledger, month-led annotations, ordinal week labels, or lifecycle-scale spacing. Project-period matrices, model timing, session timing, and execution rhythm must show actual dates or explicit date ranges appropriate to the selected grain. Never substitute generic weekday-only labels where the reader is comparing calendar days.

## Chart contracts

### Official daily and cumulative Token

- Use a shared date axis.
- Follow the adaptive grain contract. For 14 days or fewer, print every date tick in a compact month/day form; do not reduce the axis to an unlabeled start and end.
- Draw cumulative official Token as an unsmoothed blue line with a restrained area wash.
- Draw official daily Token as thin zero-based bars below it.
- Mark the peak date with a ring and exact label.
- The tooltip may show the same-date local reconstruction as context, but must label it separately and must not imply row-level reconciliation.
- Animate the counter and line once when first shown; do not add replay controls.

### Token ledger

- Label this chart as local reconstruction whenever official usage is the headline source.
- Use horizontal rungs on a common zero baseline.
- Encode cache read, new input, and output with color.
- Choose a dynamic nice rung unit targeting roughly 25–55 rungs for the largest month.
- Group by the active date grain: daily for 1–14 days, weekly or daily for 15–92 days, and monthly beyond 92 days.
- Label each column or row with its actual date or explicit date range. Mark incomplete calendar months with `*` only when the active grain is monthly.
- Lay out up to seven daily groups or six weekly/monthly groups per desktop row; reduce the count per row on mobile without hiding the period labels.

### Projects

- Rank logical projects with a zero-based horizontal bar chart.
- Use blue only for the top two; keep the remainder black/gray.
- Pair it with a selected-range first-call-period session matrix using square-root area scaling; do not imply that this is the session's original lifetime start period.
- Label matrix columns with real dates or explicit week ranges. For 14 days or fewer, use daily columns rather than forcing the data into abstract weeks. Increase the minimum visible point area enough that low-cost sessions remain legible while preserving square-root area differences.

### Models and activities

- Show model presence as date marks, not as a decorative flow.
- Aggregate model date marks from the selected, already-scaled fact rows and reconcile them to the selected-range model totals. Never apply a separate per-model scale.
- Use the active grain and print actual dates or explicit date ranges on the time axis. Do not use anonymous positions such as “第 1 周” or leave a short-range axis unlabeled.
- Rank activities as lollipops with numeric value labels.
- Describe model timing as correlation only.

### Sessions

- Use one point per in-range session.
- Use a log cost axis and square-root Token area.
- Highlight Top 5 with rings; show single-session estimated-cost median and P95 reference lines.
- For one- or two-day ranges, use actual session timestamps and hour labels. For longer ranges, use local calendar dates to avoid timezone drift.

### Weekday and hour

- Use a dot heatmap, square-root area, and opacity.
- Allow Token/call toggle.
- Highlight only the peak cell.
- For 14 days or fewer, compare actual local dates by hour instead of collapsing them into generic weekdays. Label every selected date and keep zero-activity hours present.
- Place each date's total in an adjacent summary band aligned to that date, separated from the hourly matrix by a thin vertical rule. The summary band must use the same metric as the heatmap toggle.
- For longer ranges, aggregate according to the adaptive grain, but keep explicit dates or date ranges visible; weekday summaries may be secondary context, never the only time labels.

## Range summary

Chapter 07 is a factual summary of the active date range. It is not an advice, recommendation, diagnosis, or action section.

- Use four or fewer compact facts. Official range Token and its peak may come from filtered official buckets; project, model, session, hour, cost, and local Token facts must come from the filtered local fact subset. Label the layer whenever ambiguity is possible.
- Prefer labels and values over explanatory prose. Every statement must contain a number, share, date, or named category that the reader can verify elsewhere in the report.
- Do not use imperative verbs or recommendation frames such as “建议”“应该”“可优先”“需要关注”“下一步”“控制”“优化”“复查”. Do not infer waste, efficiency, intent, quality, or business value from consumption alone.
- A natural default microcopy pattern is:

  - chapter label: `07 · 范围摘要`
  - title: `{开始日期}—{结束日期}`
  - lead: `官方账户 Token {数量}；本地重建 {数量}`
  - fact labels: `官方 Token 最高的一天`、`本地估算成本占比最高的项目`、`本地主要模型`、`本地调用最集中的时段`

If a fact is unavailable or tied, omit it or state the tie directly; never fill the space with generic commentary.

## Motion rules

- Keep motion inside the interactive HTML. Do not generate MP4 previews.
- Animate once when a chart first enters the viewport.
- A date-range change may redraw the affected charts, but it must not expose a replay button or restart unrelated page decoration.
- Never auto-loop.
- Use motion to reveal sequence or accumulation, not to decorate.
- Respect `prefers-reduced-motion`.
- Support `?static=1` for deterministic screenshots and print.
- Keep tooltips available but ensure the static state is understandable without hover.

## Copy rules

- First define the monetary metric as “按 API 价格估算的成本”; then shorten it to “估算成本”. Never imply that it is a Codex subscription bill or remaining quota.
- Name percentile scope explicitly: “活跃日估算成本 P95” and “单会话估算成本 P95” are different metrics.
- Use neutral chapter titles that remain true for different datasets. Put findings in adjacent numbers and sentences.
- Prefer direct Chinese labels. Remove implementation vocabulary, component-demo badges, management jargon, and slogan-like contrast sentences.
- In the opening strip, prefer Chinese large-number units such as `亿` and `万` so readers do not need to translate `B` or `M`. Keep exact integers in detail tables and chart tooltips.
- Translate CodeBurn task types in visible labels and retain the original category only in tooltips when useful.
- Keep Chapter 07 descriptive and numerical. Consumption data alone does not authorize recommendations to the reader.

## Responsive and print rules

- Desktop target: 1440 px.
- Mobile target: 390 px with no document-level horizontal overflow.
- Keep the Codex-style chapter tick rail on desktop only. Reserve a stable left gutter for it and hide it for print. On mobile, use the top text navigation defined above.
- Capture both the cover and each full chapter composition; chart-only screenshots cannot detect weak hierarchy.
- Stack two-up charts on mobile.
- Reduce bubble size and tick density on mobile; do not merely scale the desktop chart.
- Keep precision tables inside their own horizontal scroller.
- Print to A4 with fixed millimeter content width, stacked charts, and an explicit chart resize after print media activates.

## Effects to reject

- 3D bars, fake depth, perspective, or spinning scenes;
- infinite glow, pulse, or particle backgrounds;
- bar-chart races for static historical totals;
- streamgraphs that obscure exact dates or a zero baseline;
- morphing between unrelated metrics;
- animation that changes ranking or causality;
- copied Lieflat source or styles that depend on its noncommercial license.

Use the bundled Apache-2.0 ECharts 6.1.0 runtime. Lieflat Charts is a visual reference only.
