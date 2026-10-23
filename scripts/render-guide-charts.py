#!/usr/bin/env python3
"""Render guide charts from versioned evidence; Python 3.10+ / matplotlib 3.7+."""
import argparse
import json
from decimal import Decimal
from pathlib import Path
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.lines import Line2D
from matplotlib.patches import Patch
from matplotlib.ticker import PercentFormatter, MultipleLocator

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / 'docs/guide/assets'
DATA = json.loads((ASSETS / 'marketing-results.json').read_text())
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--only', choices=['marketing-harness-evolution', 'marketing-staged-search',
                                     'marketing-evolution-overview', 'staged-search-flow'])
ONLY = parser.parse_args().only
BLUE, ORANGE, INK, GREY, GREEN = '#3155d9', '#b35518', '#182438', '#606b7b', '#287567'
plt.rcParams.update({'font.family': 'DejaVu Sans', 'font.size': 11,
    'axes.spines.top': False, 'axes.spines.right': False, 'axes.titleweight': 'bold',
    'svg.hashsalt': 'gear-guide-marketing-v2', 'savefig.facecolor': 'white'})


def save(fig, name):
    for ext in ['svg', 'png']:
        fig.savefig(ASSETS / f'{name}.{ext}', dpi=170, bbox_inches='tight',
                    metadata={'Creator': 'Gear; scripts/render-guide-charts.py'})
    plt.close(fig)


def axes_style(ax, xlim, ylim):
    ax.set_xlim(*xlim)
    ax.set_ylim(*ylim)
    ax.xaxis.set_major_locator(MultipleLocator(5))
    ax.yaxis.set_major_locator(MultipleLocator(5))
    ax.xaxis.set_major_formatter(PercentFormatter(100, decimals=0))
    ax.yaxis.set_major_formatter(PercentFormatter(100, decimals=0))
    ax.set_xlabel('Pass rate', labelpad=10)
    ax.set_ylabel('Objective completion', labelpad=10)
    ax.grid(alpha=.14)
    ax.tick_params(length=0, pad=7, colors=GREY)
    for spine in ax.spines.values():
        spine.set_color('#cbd1dc')


def label(ax, text, xy, offset, color=INK, align='left'):
    ax.annotate(text, xy, xytext=offset, textcoords='offset points', ha=align,
                va='center', fontsize=10, color=color,
                arrowprops={'arrowstyle': '-', 'color': color, 'alpha': .4, 'lw': .7})


def arrow(ax, start, end, **kwargs):
    ax.annotate('', end, start, arrowprops={'arrowstyle': '->', 'color': BLUE,
                'lw': 2, 'shrinkA': 5, 'shrinkB': 5, **kwargs})


def chart(key, name, title, effort_index, *, include_harness=False):
    rows = DATA[key]
    fig = plt.figure(figsize=(13.5, 8.2))
    ax = fig.add_axes([.085, .32, .89, .50])
    ref = ax
    # The same zoom in both examples makes their round-to-round gains comparable.
    axes_style(ax, (22, 62), (72, 94))
    if title:
        ax.set_title('Automation Bench / Marketing - 100 tasks', loc='left', fontsize=13, pad=24)
        fig.suptitle(title, x=.085, y=.965, ha='left', fontsize=20, fontweight='bold', color=INK)
        fig.text(.085, .91, 'Move right for more tasks passed; move up for more objectives completed.', color=GREY, fontsize=11)
    else:
        ax.set_title('Automation Bench / Marketing · 100 tasks', loc='left',
                     fontsize=20, fontweight='bold', color=INK, pad=24)

    accepted = [r for r in rows if r['round'] == 0 or r['decision'].startswith(('accepted', 'promoted'))]
    if include_harness:
        harness_accepted = [r for r in DATA['harnessEvolution']
                            if r['round'] == 0 or r['decision'].startswith('accepted')]
        # Harness R4 and the GEPA baseline are the same retained version.
        accepted = harness_accepted[:-1] + accepted
    points = [(r['candidatePassed'], r['partialCredit'] * 100) for r in accepted]
    for a, b in zip(points, points[1:]):
        arrow(ax, a, b)
    ax.scatter(*zip(*points), c=BLUE, s=64, zorder=5, label='Retained · GPT 5.6 Luna medium')
    if key == 'harnessEvolution':
        offsets = {1: (5, -34), 2: (-57, 23), 3: (18, -20),
                   4: (46, -2), 5: (-26, 23)}
        labels = {1: 'R1 · 24 / 75.15', 2: 'R2 · 33 / 77.42',
                  3: 'R3 · 36 / 80.40', 4: 'R4 · 36 / 81.19', 5: 'R5 · 34 / 82.30'}
        annotations = [(row, labels[row['round']], offsets[row['round']], 'left')
                       for row in rows if row['round'] != 0]
    elif include_harness:
        offsets = {0: (-42, -6), 1: (40, 5), 3: (0, 30)}
        labels = {0: 'Harness R4 / GEPA start\n36 / 81.19',
                  1: 'GEPA R1\n36 / 80.59', 3: 'GEPA R3 · 40 / 83.87'}
        annotations = [(row, labels[row['round']], offsets[row['round']],
                        'right' if row['round'] == 0 else 'center' if row['round'] == 3 else 'left')
                       for row in rows if row['candidatePassed'] is not None]
        harness_offsets = {1: ((0, -28), 'center'), 2: ((-3, -33), 'center'),
                           3: ((40, -28), 'left'), 5: ((-40, 38), 'right')}
        for row in DATA['harnessEvolution']:
            if row['round'] in harness_offsets:
                offset, align = harness_offsets[row['round']]
                text = f"Harness R{row['round']}\n{row['candidatePassed']} / {row['partialCredit'] * 100:.2f}"
                annotations.append((row, text, offset, align))
    else:
        offsets = {0: (-12, 25), 1: (-16, -28), 3: (-57, 26)}
        labels = {0: 'GEPA start · from Example 1\n36 / 81.19',
                  1: 'R1 · 36 / 80.59', 3: 'R3 · 40 / 83.87'}
        annotations = [(row, labels[row['round']], offsets[row['round']],
                        'right' if row['round'] == 0 else 'left')
                       for row in rows if row['candidatePassed'] is not None]
    other_label = True
    for row, text, offset, align in annotations:
        xy = (row['candidatePassed'], row['partialCredit'] * 100)
        retained = row in accepted
        if not retained:
            ax.scatter(*xy, marker='D', s=55, facecolors='white', edgecolors=ORANGE,
                       linewidths=1.6, zorder=5, label='Explored, not retained' if other_label else None)
            other_label = False
        label(ax, text, xy, offset, BLUE if retained else ORANGE, align)

    # b4ce300 is the unoptimized DSH carrier, before any Marketing Harness mutation.
    # The combined chart connects it through the Harness and GEPA search stages.
    original = DATA['harnessEvolution'][0]
    original_xy = (original['candidatePassed'], original['partialCredit'] * 100)
    ax.scatter(*original_xy, s=85, facecolors='white', edgecolors=BLUE, linewidths=1.8, zorder=6)
    label(ax, f'Original DSH · GPT 5.6 Luna medium\n{original_xy[0]} / {original_xy[1]:.2f}',
          original_xy, (0, 26), BLUE, 'center')

    maxrow = DATA['effortComparison'][effort_index]
    maxxy = (maxrow['max'], maxrow['maxPartialCredit'] * 100)
    arrow(ax, points[-1], maxxy, linestyle='--', lw=1.6)
    ax.scatter(*maxxy, c=BLUE, marker='D', s=95, zorder=6)
    label(ax, f"GPT 5.6 Luna max · {maxxy[0]} / {maxxy[1]:.2f}", maxxy, (-8, 23), BLUE, 'center')
    if key == 'stagedEvolution':
        old = DATA['effortComparison'][0]
        oldxy = (old['max'], old['maxPartialCredit'] * 100)
        ax.scatter(*oldxy, s=55, facecolors='white', edgecolors=BLUE, zorder=5)
        previous_label = 'Harness R4 · Luna max' if include_harness else 'Previous Harness · max'
        label(ax, f'{previous_label}\n50 / 88.98', oldxy, (-38, 40), BLUE, 'center')
    codex = DATA['codexAstraMaxReference']
    cxy = (codex['passed'], codex['partialCredit'] * 100)
    ax.scatter(*cxy, c=INK, marker='s', s=62, zorder=5)
    label(ax, 'Codex + Astra max\n57 / 84.08', cxy, (0, -33), INK, 'center')

    if key == 'stagedEvolution':
        # A separate model evaluation on Aliyun, not another evolution round.
        astra = DATA['championAstraMaxEvaluation']
        axy = (100 * astra['passed'] / astra['total'], astra['partialCredit'] * 100)
        arrow(ax, maxxy, axy, linestyle='--', lw=1.6)
        ax.scatter(*axy, c=BLUE, marker='D', s=95, zorder=6)
        label(ax, f"GPT 6 Astra max · {axy[0]:.0f} / {axy[1]:.2f}",
              axy, (-5, 42), BLUE, 'right')

    # User-requested Marketing reference: x from Zapier, y from AA; identify both sources below.
    names = {'gpt-6-astra': ('Astra max*', INK, (-12, -25), 'center'),
             'gemini-3-8-flash': ('Gemini 3.8 Flash high*', GREEN, (15, -18), 'left')}
    for model in DATA['officialModelReferences']['models']:
        text, color, offset, align = names[model['slug']]
        xy = (model['passRate'], model['objectiveCompletion'])
        ref.scatter(*xy, s=75, marker='o', facecolors='white', edgecolors=color, linewidths=1.7, zorder=5, label='Official held-out*' if model['slug'] == 'gpt-6-astra' else None)
        label(ref, f'{text}\n{xy[0]:.2f} / {xy[1]:.2f}', xy, offset, color, align)
    ax.legend(loc='upper left', bbox_to_anchor=(.085, .235), bbox_transform=fig.transFigure,
              borderaxespad=0, ncol=3, frameon=False, fontsize=10)
    fig.text(.085, .155, 'Labels: pass rate / completion (%). Solid arrows: accepted iterations. Dashed arrows: separate model / effort evaluations.', fontsize=9.5, color=GREY)
    fig.text(.085, .11, '* Official held-out Marketing references: pass rate from Zapier; objectives completed from AA (v1.0.6; retrieved 2026-09-14).',
             fontsize=9.5, color=GREY)
    save(fig, name)


def overview():
    """Compare domains, then show measured Marketing candidates in sequence."""
    blue, pale_blue, purple, grey = '#42649a', '#dce5f1', '#cdbbdf', '#cfcfcf'
    purple_ink, ink, muted = '#8a60a4', '#292929', '#666666'
    coding = json.loads((ASSETS / 'coding-results.json').read_text())
    support = json.loads((ASSETS / 'support-results.json').read_text())
    harness, staged = DATA['harnessEvolution'], DATA['stagedEvolution']
    champion = [r for r in staged if r['decision'].startswith('promoted')][-1]
    astra = DATA['championAstraMaxEvaluation']
    final_max = next(r for r in DATA['effortComparison']
                     if r['harness'] == astra['sourceChampion'][:8])
    groups = [
        ('Coding', [coding[k]['passRate'] for k in ['baseline', 'optimized', 'max']]),
        ('Marketing', [100 * harness[0]['candidatePassed'] / harness[0]['valid'],
                       100 * champion['candidatePassed'] / champion['valid'], final_max['max']]),
        ('Support', [support[k]['passRate'] for k in ['baseline', 'optimized', 'max']]),
    ]
    # H4 and the GEPA baseline are the same evaluation. Omit unevaluated rounds
    # before assigning consecutive display indices; keep source evidence intact.
    history = [r for r in harness + staged[1:]
               if r['candidatePassed'] is not None and r['partialCredit'] is not None]
    round_labels = [str(i) for i in range(len(history))]
    kept = [r['round'] == 0 or r['decision'].startswith(('accepted', 'promoted'))
            for r in history]
    pass_rates = [100 * r['candidatePassed'] / r['valid'] for r in history]
    completion = [100 * r['partialCredit'] for r in history]

    with plt.rc_context({'font.family': 'STIXGeneral', 'font.size': 15,
                         'text.color': ink, 'axes.labelcolor': ink,
                         'xtick.color': muted, 'ytick.color': muted,
                         'svg.hashsalt': 'gear-readme-overview-v7'}):
        fig = plt.figure(figsize=(16.8, 6.2))
        left = fig.add_axes([.065, .22, .365, .62])
        right = fig.add_axes([.565, .22, .365, .62])
        completion_axis = right.twinx()

        def style(ax):
            ax.set_axisbelow(True)
            ax.tick_params(length=0, pad=7, labelsize=15)
            for spine in ax.spines.values():
                spine.set_color('#cbd1dc')
                spine.set_linewidth(1.2)

        for ax in [left, right, completion_axis]:
            style(ax)
        left.grid(axis='y', color='#e7eaf0', linewidth=1.2)
        right.grid(axis='y', color='#e7eaf0', linewidth=1.2)
        left.set_title('GPT 5.6 Luna + DSH', fontsize=18, fontweight='bold', pad=18)
        right.set_title('Marketing · GPT 5.6 Luna medium', fontsize=18, fontweight='bold', pad=18)
        fig.legend(handles=[
            Patch(facecolor=grey, label='Base (medium)'),
            Patch(facecolor=purple, label='Gear (medium)'),
            Patch(facecolor=pale_blue, edgecolor=blue, linewidth=2, label='Gear (max)')],
            loc='upper left', bbox_to_anchor=(.06, .98), frameon=False,
            ncol=3, fontsize=16, handlelength=1, columnspacing=1.2, handletextpad=.45)
        fig.legend(handles=[
            Line2D([], [], color=blue, marker='o', markerfacecolor=blue,
                   markeredgewidth=2, linewidth=2.6, label='Task pass rate'),
            Line2D([], [], color=purple_ink, marker='s', markerfacecolor=purple_ink,
                   markeredgewidth=1.5, linewidth=2.4, linestyle='--', label='Objective completion')],
            loc='upper left', bbox_to_anchor=(.56, .98), frameon=False,
            ncol=2, fontsize=16, handlelength=1.7, columnspacing=1.2, handletextpad=.5)
        # Fill encodes selection status for both metric shapes. Round 1 failed
        # execution before its result was recovered, so use "not retained"
        # rather than describing every unselected candidate as rejected.
        fig.legend(handles=[
            Line2D([], [], color=muted, marker='o', markerfacecolor=muted,
                   markersize=8, markeredgewidth=1.8, linestyle='none',
                   label='Baseline / retained'),
            Line2D([], [], color=muted, marker='o', markerfacecolor='white',
                   markersize=8, markeredgewidth=1.8, linestyle='none',
                   label='Not retained')],
            loc='lower center', bbox_to_anchor=(.7475, .015), frameon=False,
            ncol=2, fontsize=15, handlelength=1, columnspacing=1.2, handletextpad=.5)

        left.set_ylim(0, 105)
        left.set_yticks([0, 20, 40, 60, 80, 100])
        left.set_ylabel('Task pass rate (%)', fontsize=17, fontweight='bold', labelpad=9)
        centers = [1.6 * i for i in range(len(groups))]
        left.set_xlim(-.7, centers[-1] + .7)
        left.set_xticks(centers, [g[0] for g in groups], fontsize=20, fontweight='bold')
        for center, (_, values) in zip(centers, groups):
            positions = [center - .36, center, center + .36]
            for i, (x, value) in enumerate(zip(positions, values)):
                left.bar(x, value, width=.32, color=[grey, purple, pale_blue][i],
                         edgecolor=blue if i == 2 else 'none', linewidth=2, zorder=3)
                label = f'{value:.1f}'
                left.text(x, value + 1.5, label, ha='center', va='bottom',
                          fontsize=18, fontweight='bold')
            delta = values[-1] - values[0]
            y = max(values) + 10
            left.plot([positions[0], positions[0], positions[-1], positions[-1]],
                      [y - 1.5, y, y, y - 1.5], color=blue, linewidth=1.2)
            left.text(center, y + 1, f'+{delta:.1f} pp', ha='center', va='bottom',
                      fontsize=18, fontweight='bold', color=blue)

        # Two explicitly labelled axes with equal 25-point spans. Lines join
        # measured candidates in display order; no missing result is imputed.
        right.set_ylim(20, 45)
        right.set_yticks([20, 25, 30, 35, 40, 45])
        completion_axis.set_ylim(70, 95)
        completion_axis.set_yticks([70, 75, 80, 85, 90, 95])
        right.set_ylabel('Task pass rate (%)', color=blue, fontsize=16, fontweight='bold', labelpad=8)
        completion_axis.set_ylabel('Objective completion (%)', color=purple_ink,
                                   fontsize=16, fontweight='bold', labelpad=10)
        right.tick_params(axis='y', colors=blue)
        completion_axis.tick_params(axis='y', colors=purple_ink)
        completion_axis.spines['right'].set_visible(True)
        completion_axis.spines['left'].set_visible(False)
        right.set_xlim(-.45, len(history) - .4)
        right.set_xticks(range(len(history)), round_labels, fontsize=15)
        right.set_xlabel('Harness round', fontsize=18, fontweight='bold', labelpad=10)
        for metric, (ax, values, color, fill, marker, line) in enumerate([
            (right, pass_rates, blue, blue, 'o', '-'),
            (completion_axis, completion, purple_ink, purple_ink, 's', '--'),
        ]):
            ax.plot(range(len(history)), values, color=color, linewidth=2.6,
                    linestyle=line, zorder=3)
            for x, (value, retained) in enumerate(zip(values, kept)):
                ax.plot(x, value, marker=marker, markersize=7.5, color=color,
                        markerfacecolor=fill if retained else 'white',
                        markeredgewidth=2, zorder=4)
                dy = (21 if x == 1 else 10) if metric == 0 else -14
                # Format the decimal source so 0.7515 × 100 rounds to 75.2,
                # unaffected by a floating-point product of 75.14999999999999.
                display_value = value if metric == 0 else Decimal(str(history[x]['partialCredit'])) * 100
                ax.annotate(f'{display_value:.1f}',
                            (x, value), xytext=(0, dy), textcoords='offset points',
                            ha='center', va='bottom' if metric == 0 else 'top',
                            fontsize=14, fontweight='bold', color=color)

        for ext in ['svg', 'png']:
            metadata = {'Creator': 'Gear; scripts/render-guide-charts.py'}
            if ext == 'svg':
                metadata['Date'] = None
            path = ASSETS / f'marketing-evolution-overview.{ext}'
            fig.savefig(path, dpi=240, bbox_inches='tight', pad_inches=.2, metadata=metadata)
            if ext == 'svg':
                path.write_text('\n'.join(line.rstrip() for line in path.read_text().splitlines()) + '\n')
        plt.close(fig)

if ONLY in (None, 'marketing-evolution-overview'):
    overview()


for key, name, title, index, include_harness in [
    ('harnessEvolution', 'marketing-harness-evolution', 'Example 1 / Evolve a harness for Marketing', 0, False),
    ('stagedEvolution', 'marketing-staged-search', 'Example 2 / Customize your evolve algorithm', 1, False),
]:
    if ONLY in (None, name):
        chart(key, name, title, index, include_harness=include_harness)

if ONLY in (None, 'staged-search-flow'):
    fig, ax = plt.subplots(figsize=(11.8, 2.9))
    ax.axis('off')
    labels = [('Select a parent', 'Scope-qualified archive'), ('Propose mutations', 'Up to 4 Meta candidates'),
              ('Local → bridge', 'Up to 2 candidates'), ('Global evaluation', 'At most 1 finalist'),
              ('Record decisions', 'Archive + champion gate')]
    for i, (title, sub) in enumerate(labels):
        x = .02 + i * .2
        ax.text(x, .58, title, transform=ax.transAxes, fontsize=11, fontweight='bold', color=BLUE)
        ax.text(x, .38, sub, transform=ax.transAxes, fontsize=9.5, color=INK)
        if i < 4:
            ax.annotate('', xy=(x + .19, .65), xytext=(x + .16, .65), xycoords='axes fraction', arrowprops={'arrowstyle': '->', 'color': GREY})
    ax.text(.02, .1, 'Measured case: all three rounds selected 8b651c5. Cross-parent reproduction and crossover were not observed.', transform=ax.transAxes, fontsize=10, color=GREY)
    ax.set_title('A mutation-based evolutionary search, with staged evaluation budgets', loc='left', fontsize=15, fontweight='bold')
    save(fig, 'staged-search-flow')
print(f'Rendered {ONLY or "all guide figures"} as SVG and PNG from versioned chart data.')
