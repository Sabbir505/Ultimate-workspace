import os
import random
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
from matplotlib.patches import FancyBboxPatch

random.seed(7)
os.makedirs("docs", exist_ok=True)

BLUE = "#1F4E79"
LIGHT = "#eef2f7"
GREEN = "#2e7d32"

def box(ax, x, y, w, h, text, fc=LIGHT, ec=BLUE, fs=9, bold=False):
    b = FancyBboxPatch((x, y), w, h, boxstyle="round,pad=0.02,rounding_size=0.05",
                       linewidth=1.2, edgecolor=ec, facecolor=fc)
    ax.add_patch(b)
    ax.text(x + w / 2, y + h / 2, text, ha="center", va="center",
            fontsize=fs, fontweight="bold" if bold else "normal", color="#222222")

def arrow(ax, x1, y1, x2, y2):
    ax.annotate("", xy=(x2, y2), xytext=(x1, y1),
                arrowprops=dict(arrowstyle="-|>", color=BLUE, lw=1.5))

fig, ax = plt.subplots(figsize=(12, 7))
ax.set_xlim(0, 12); ax.set_ylim(0, 8); ax.axis("off")

# Data sources
box(ax, 0.6, 6.8, 2.3, 0.9, "Data Sources\n(CRM, Web, Mobile)", fc="#cfe2f3", bold=True)
box(ax, 3.2, 6.8, 2.3, 0.9, "ETL Pipeline\nAirflow · Spark", bold=True)
box(ax, 5.8, 6.8, 2.3, 0.9, "Warehouse\nPostgreSQL", bold=True)
box(ax, 8.4, 6.8, 2.3, 0.9, "Analytics Engine\nPython · dbt", bold=True)

arrow(ax, 2.9, 7.25, 3.2, 7.25)
arrow(ax, 5.5, 7.25, 5.8, 7.25)
arrow(ax, 8.1, 7.25, 8.4, 7.25)

# Applications
box(ax, 0.8, 4.4, 2.2, 0.9, "Atlas Core\n{app}\n({u:,} users)".format(
    app="Dashboard", u=random.randint(18000, 25000)), fc=GREEN, ec=GREEN, bold=True)
box(ax, 3.4, 4.4, 2.2, 0.9, "Nimbus API\n{app}\n({u:,} req/s)".format(
    app="Gateway", u=random.randint(900, 1500)), fc=GREEN, ec=GREEN, bold=True)
box(ax, 6.0, 4.4, 2.2, 0.9, "Pulse Insights\n{app}\n({u:,} alerts/mo)".format(
    app="AI Alerts", u=random.randint(1200, 4000)), fc=GREEN, ec=GREEN, bold=True)
box(ax, 8.6, 4.4, 2.2, 0.9, "Orbit Mobile\n{app}\n({u:,} installs)".format(
    app="App", u=random.randint(5000, 20000)), fc=GREEN, ec=GREEN, bold=True)

for cx in (1.9, 4.5, 7.1, 9.7):
    arrow(ax, cx, 6.8, cx, 5.3)

# Insights layer
box(ax, 2.6, 2.0, 3.0, 1.0, "Insights & Reporting\nRevenue · Churn · Usage", bold=True)
box(ax, 6.4, 2.0, 3.0, 1.0, "Forecasting & ML\nDemand · Retention", bold=True)
arrow(ax, 1.9, 4.4, 4.1, 3.0)
arrow(ax, 4.5, 4.4, 4.1, 3.0)
arrow(ax, 7.1, 4.4, 7.9, 3.0)
arrow(ax, 9.7, 4.4, 7.9, 3.0)

# Stakeholders
box(ax, 1.6, 0.4, 2.4, 0.9, "Executives", fc="#ffe6cc", ec="#d97b29")
box(ax, 4.8, 0.4, 2.4, 0.9, "Product Teams", fc="#ffe6cc", ec="#d97b29")
box(ax, 8.0, 0.4, 2.4, 0.9, "Customers", fc="#ffe6cc", ec="#d97b29")
arrow(ax, 3.6, 2.0, 2.8, 1.3)
arrow(ax, 4.1, 2.0, 6.0, 1.3)
arrow(ax, 7.9, 2.0, 9.2, 1.3)

ax.text(6, 8.35, "NovaWorks Analytics — Architecture & Data Flow", ha="center",
        fontsize=16, fontweight="bold", color=BLUE)
fig.tight_layout()
fig.savefig("docs/diagram.png", dpi=150, bbox_inches="tight")
print("diagram done")
