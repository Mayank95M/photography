# Photographs — a portfolio site with its own admin panel

A photography portfolio for GitHub Pages, with a private admin panel for adding, editing and deleting photos, trimming the borders you added for Instagram, enhancing small photos with AI, and importing your whole Instagram history in one go.

Everything runs in the browser. There is no server and nothing to install: GitHub Pages hosts the site, and the admin panel saves your changes straight into this repository.

---

## What visitors see

- **An aperture that opens.** On a first visit the page loads behind a camera iris; progress is shown as f-stops, from ƒ/22 to ƒ/1.4, and then the iris opens onto the site.
- **Your name, set like an exhibition title**, under a slideshow of your featured photographs.
- **Three ways to look at the work:**
  - *Prints* — an exhibition hang: photographs at different sizes, each with a museum-style wall label. Prints develop from blank paper as they come into view.
  - *Contact sheet* — your photographs on strips of 35 mm film with frame numbers; a red grease-pencil loop is drawn round the frame you point at, and your featured photographs are permanently circled, the way photographers mark their selects.
  - *Light table* — every print spread out on a glowing table that you can drag around in any direction.
- **A viewer** that flies each photograph up from where you clicked it, with title, place, date, caption and camera details, keyboard and swipe navigation, a close-up zoom, and a link you can share.
- **An About page** where your portrait opens from a small window to fill the screen as you scroll, while your name parts around it.
- Two looks: **Paper** (prints on a pale wall) and **Darkroom** (prints on black), or follow each visitor's light/dark setting.

---

## Setting it up (about 15 minutes)

### 1. Create the repository

1. Sign in to GitHub and create a new repository, for example `photographs`.
2. Make it **Public** (GitHub Pages on a free account needs a public repository).
3. Don't add a README; leave it empty.

### 2. Upload these files

Easiest: on the empty repository page, click **uploading an existing file**, then drag **everything inside this folder** (not the folder itself) into the browser window, and click **Commit changes**.

> The `assets` folder must stay a folder. Chrome and Edge keep folders when you drag them in. If yours doesn't, use [GitHub Desktop](https://desktop.github.com/) instead: clone the repository, copy these files into it, then Commit and Push.
>
> If GitHub refuses the upload as too large, upload everything except the folders `assets/models/realesrgan-x2plus` and `assets/models/realesrgan-x4plus`. Then zip those two folders inside an `assets/models` folder and install the ZIP from the admin panel (**Settings → Site files**).

### 3. Turn on GitHub Pages

1. In the repository, open **Settings → Pages**.
2. Under **Build and deployment**, set **Source** to *Deploy from a branch*, **Branch** to `main`, folder `/ (root)`, and click **Save**.
3. After a minute, your site is at `https://YOUR-USERNAME.github.io/photographs/` (for you: `https://mayank95m.github.io/photographs/`, if you name the repository `photographs`).

The site starts empty: it says the wall is ready for prints.

### 4. Create the access token for the admin panel

The admin panel needs permission to save into this one repository. You give it that with a *fine-grained personal access token*:

1. Open **[GitHub → Settings → Developer settings → Fine-grained tokens → Generate new token](https://github.com/settings/personal-access-tokens/new)**.
2. Name it `Photo site admin` and choose an expiry (a year is sensible; you can make a new one later).
3. **Repository access:** *Only select repositories* → pick `photographs`.
4. **Permissions → Repository permissions → Contents:** *Read and write*. Nothing else.
5. Click **Generate token** and copy it (it starts with `github_pat_`). GitHub only shows it once.

### 5. Open the admin panel

Go to `https://YOUR-USERNAME.github.io/photographs/admin/`.

- The repository name is filled in for you. Paste the token.
- Leave **Remember this device** ticked and choose a **passcode**. The token is stored on this device encrypted with that passcode, so next time you only type the passcode.
- Click **Connect**.

Do the same on any other computer or phone you want to use; each device stores its own encrypted copy.

---

## Bringing in your Instagram photos

### Can the site take photos straight from Instagram?

Not live, no. Instagram closed the API that personal accounts used (the *Basic Display API*) in December 2024; what remains only works for Business and Creator accounts and still needs a registered Meta developer app. Embedding posts would show Instagram's own frame, with your borders, and none of the site's design.

What Instagram does give everyone is a **download of all your posts in their original stored quality**. You request it once, download one ZIP, and drop that ZIP into the admin panel. You never need to save or edit photos one at a time: the importer reads every post, its date and caption, trims the borders, enhances the resolution and publishes them all.

### Steps

1. In the Instagram app or on instagram.com: **Settings → Accounts Center → Your information and permissions → Export your information → Create export**.
2. Pick your Instagram account and **Export to device**.
3. Under **Customise information**, keep only **Posts** (this keeps the file small).
4. Set **Date range: All time**, **Format: JSON**, **Media quality: High**, and start the export.
5. Instagram emails you when it is ready (usually within an hour). Download the ZIP. **Don't unzip it.** If Instagram split it into several parts, use all of them at once.
6. In the admin panel, open **Import from Instagram** and drop the ZIP.
7. Check the photos it found. Untick any you don't want. Photos with a border are labelled, and any it is unsure about say *Check border*; use **Adjust crop** on those.
8. Click **Import**. Keep the tab open while it works. When it finishes, it publishes everything in one go.

Keep the ZIP somewhere safe: it is your original copy of every post.

**Captions:** the first line of each caption becomes the title and the rest the caption, with hashtags removed (both can be changed before importing). Emoji and Hindi text come through correctly.

**Importing again later** is safe: photos already on the site are recognised and left unticked.

---

## Everyday use

**Photos** — every photograph, in the order the site shows them.
- Drag to reorder. **Sort by date** puts the newest first.
- Click a photo to edit its title, caption, place, date, tags, camera details, or to mark it **Featured** (shown in the opening slideshow and circled on the contact sheet) or **Hidden**.
- **Crop or enhance…** re-crops a published photo, and offers to enhance it if it is small.
- **Improve quality** (also its own tab) re-processes photos that look soft on large screens; see below.
- **Select** lets you feature, hide or delete several at once.
- Tags become filters on the site. Use a few broad ones (Mountains, Street, People).

**Add photos** — from your computer or phone. Each one is checked for a border and shows what will happen before you add it. **Compare before and after** shows the enhancement at real pixels.

**Improve quality** — makes photos already on your site hold up on large screens, keeping their titles, captions, dates and order.
- Each photo is labelled: *Low resolution*, *Smoothed by the fast enhancer*, *Sharp* or *Best quality*. The ones that need work are selected for you.
- **Drop originals here** for the best result: your Instagram archive ZIP (photos are found by their Instagram id), original files from your phone or computer, or versions enlarged in another app (found by name, or by how they look). Files must show the same framing as the photo on your site.
- Choose **Best quality** or **Fast**, a **Finish** (Natural, Vivid or Off) and a **Size**, then **Improve**. It shows an estimate, keeps your screen on while it works, and stages each photo as it finishes. **Compare** shows before and after at real pixels; **Publish** puts them on the site.
- Rather use a desktop app? **Download photos for a desktop app** gives you a ZIP of the selected photos, borders removed, each named after its photo. Enlarge the folder in [Upscayl](https://upscayl.org) (free, for Windows, Mac and Linux; fastest with a graphics card), then drop the results back in.

**About page** — your portrait (click your face so it stays in view on any screen), name, introduction, biography, facts and links.

**Settings** — Paper or Darkroom, the opening line, the default view, slideshow speed, camera details on labels, the published image size and JPEG quality, the enhancement quality (Best or Fast) and the finish (Natural, Vivid or Off) used for new photos.

**Site files** (in Settings) — installs updates to the site from a ZIP, through the same connection the admin uses to publish: drop the ZIP as it is, without unzipping it. Its files are added to the repository in one change; photos, texts and settings are never touched. Use it for the Best quality models (their files are too large for GitHub's upload page) and for later updates, instead of uploading files on GitHub.

### Publishing

Changes are collected first, and **Publish** saves them all to GitHub as one change. The site updates about a minute later, and the admin panel tells you when it is live. Unpublished changes survive closing the tab.

---

## How the tools work

**Border removal** looks at each edge for a band of one flat colour (white, black, beige, any colour) that ends in a sharp straight edge, and also catches blurred-copy backgrounds and thin keylines inside a mat. It steps over text written on the border, such as a handle or a place name. When a bright sky runs into a white border it uses the opposite side, since apps centre the photo. Anything it isn't sure about is left for you to check.

**Resolution enhancement** uses [Real-ESRGAN](https://github.com/xinntao/Real-ESRGAN), running on your device's graphics chip through TensorFlow.js (any recent Chrome, Edge, Firefox or Safari on a computer). Besides adding resolution, it cleans up the JPEG blockiness Instagram adds.
- **Best quality** uses the full models, `RealESRGAN_x2plus` for photos that need up to 2.5× (most Instagram photos) and `RealESRGAN_x4plus` for smaller ones. They keep natural-looking texture. Expect about 1–3 minutes a photo on a laptop, faster with a graphics card; the first use downloads 33 MB, which the browser then keeps. The two models are installed once from **Settings → Site files**; until they are, photos are enhanced with Fast.
- **Fast** uses the small `realesr-general-x4v3` model: seconds a photo, but it smooths fine texture such as foliage, fur and skin.
- The result is sized to the published size (2560 px on the long edge unless you change it), but never stretched more than 1.5× beyond what the model produced. Photos already large enough are not enhanced.
- Enhancement adds detail that looks right; it can't recover the exact detail Instagram threw away. For favourite photos, an original file is always better, and Improve quality takes one whenever you have it.

**Finishing** is applied after the photo is sized: local contrast for depth, sharpening matched to the screen size, a touch of vibrance, and a very fine grain that keeps enlarged photos from looking plastic. *Natural* is subtle; *Vivid* is stronger.

**Files:** each photograph is stored twice: `photos/full/` (JPEG, for the viewer) and `photos/thumb/` (a smaller WebP, for the gallery). The list of photographs and all settings are plain JSON in `data/`.

---

## Security, in plain terms

- The admin page is public, like the rest of the site, but it can't do anything without a token that can write to this repository. GitHub checks that on every change.
- The token stays on your devices: encrypted with your passcode in the browser's storage, and decrypted only for the open tab. It is never put in the repository.
- Give the token access to this repository only, with only Contents permission, and an expiry. If a device is lost, delete the token on GitHub; that cancels it everywhere.
- Image files are re-encoded before upload, which drops all location (GPS) data from your photos.
- The repository is public, so the full-size images can be downloaded by anyone who looks for them. **Discourage saving images** stops casual right-click and long-press saving, nothing more.
- Deleting a photo removes it from the site and the current files, but Git keeps history. To erase something completely, the repository's history has to be rewritten.

---

## Limits worth knowing

- GitHub Pages sites can be up to 1 GB. At the default size each photo takes about 1–2 MB (detailed, finished photos are at the top of that range), so roughly 500 photographs fit comfortably.
- GitHub rebuilds the site at most about ten times an hour. Publishing in batches (which the admin panel does) keeps you well inside that.
- Instagram has stored most photos at about 1080 px wide, and older posts at 640 px or less, which is why enhancement exists.
- Large enhancement runs need the admin tab to stay open and in front; browsers slow down work in background tabs.

## Changing the design

Colours are CSS variables at the top of `assets/css/site.css` (`--paper`, `--ink`, `--film`, `--edge` for the amber film edge print, `--grease` for the red pencil). The typefaces are Newsreader and Archivo, self-hosted in `assets/fonts`.

## Credits

Real-ESRGAN models (x2plus, x4plus, general-x4v3) © 2021 Xintao Wang, BSD-3-Clause · TensorFlow.js, Apache-2.0 · GSAP, GreenSock standard licence · Lenis, MIT · zip.js, BSD-3-Clause · exifr, MIT · Newsreader and Archivo, SIL Open Font License. Licence texts are in `assets/vendor/licenses` and `assets/models`.
