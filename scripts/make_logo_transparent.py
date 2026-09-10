# Make src-tauri/icons/final.png background transparent and roll it out.
#
# 2026-09-10 artwork: the backdrop is a dark navy (border pixels RGB 2-26,
# max channel 26) and the artwork is far brighter, so a border flood-fill at
# maxc <= 35 captures the backdrop and plateaus — raising the threshold to
# 56 doesn't eat a single artwork pixel (verified opaque% stable 26→56, and
# the content bbox settles at (226,203,1028,1003)). The previous artwork sat
# on pure black (border RGB 0-1) and needed a TIGHT threshold of 4; re-tune
# here if the artwork's backdrop changes again.
#
# Outputs:
#   public/logo.png                 512x512 (AppLogo, favicon, boot splash)
#   src-tauri/icons/app-icon-source.png  1024x1024 (tauri icon source)
import numpy as np
from PIL import Image

SRC = "src-tauri/icons/final.png"

im = np.asarray(Image.open(SRC).convert("RGB")).astype(np.int16)
h, w = im.shape[:2]
maxc = im.max(axis=2)

# 1) Backdrop mask (dark navy), keep only the component connected to the
#    border — artwork pixels enclosed by brighter content are left alone.
NEAR_MAXC = 35
# 1) Pure-black mask, keep only the component connected to the border.
near = maxc <= NEAR_MAXC
bg = np.zeros_like(near)
bg[0, :] = near[0, :]
bg[-1, :] = near[-1, :]
bg[:, 0] = near[:, 0]
bg[:, -1] = near[:, -1]
while True:
    grow = bg | (
        near
        & (np.roll(bg, 1, 0) | np.roll(bg, -1, 0) | np.roll(bg, 1, 1) | np.roll(bg, -1, 1))
    )
    if (grow == bg).all():
        break
    bg = grow

# 2) Everything not flooded stays fully opaque — the artwork edge is hard,
# so feathering would only ghost it.
alpha = np.where(bg, 0, 255).astype(np.uint8)

rgba = np.dstack([im.astype(np.uint8), alpha])
img = Image.fromarray(rgba, "RGBA")

# 3) Trim transparent margins, keep the content square.
bbox = img.getbbox()
img = img.crop(bbox)
side = max(img.size)
canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
canvas.paste(img, ((side - img.width) // 2, (side - img.height) // 2))

canvas.resize((512, 512), Image.LANCZOS).save("public/logo.png")
canvas.resize((1024, 1024), Image.LANCZOS).save("src-tauri/icons/app-icon-source.png")
print(
    f"bbox={bbox} content={img.size} "
    f"opaque%={100.0 * (alpha > 0).sum() / (h * w):.1f}"
)
