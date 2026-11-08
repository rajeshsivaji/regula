document.addEventListener('DOMContentLoaded', function () {
    const BACKEND_URL = window.BACKEND_URL;
    const LICENSE_KEY = window.LICENSE_KEY;
    $('[data-toggle="tooltip"]').tooltip();

    function processFile(file) {
        if (!file) return;
        const allowed = ['image/png', 'image/jpeg', 'image/bmp', 'image/tiff', 'image/webp'];
        if (!allowed.includes(file.type)) {
            alert('Unsupported format. Use PNG, JPG, BMP, TIFF, or WEBP.');
            return;
        }
        const reader2 = new FileReader();
        reader2.onload = function (ev) {
            const footerImg = document.getElementById('footerPreviewImg');
            const footerName = document.getElementById('footerPreviewName');
            const footer = document.getElementById('filePreviewFooter');
            footerImg.src = ev.target.result;
            footerName.textContent = file.name;
            footer.style.display = 'flex';
        };
        reader2.readAsDataURL(file);
        const reader = document.getElementById('documentReader');
        if (reader) reader.image = file;
    }

    function onUploadLinkClick(e) {
        e.preventDefault();
        const reader = document.getElementById('documentReader');
        const btn = reader && reader.shadowRoot && reader.shadowRoot.querySelector('[part="menu-from-gallery-button"]');
        if (btn) btn.click();
    }

    function onFileInputChange() {
        processFile(this.files && this.files[0]);
        this.value = '';
    }

    function waitForShadowBtn(element, partName, callback) {
        const check = () => {
            const btn = element.shadowRoot && element.shadowRoot.querySelector('[part="' + partName + '"]');
            if (btn) { callback(btn); return true; }
            return false;
        };
        if (check()) return;
        const observer = new MutationObserver(() => { if (check()) observer.disconnect(); });
        observer.observe(element, { childList: true, subtree: true });
    }

    // Fix 5: named drag handlers so they can be removed without stacking
    function onDragOver(e) {
        e.preventDefault();
        this.style.borderColor = '#6f42c1';
        this.style.background = '#f3f0ff';
    }
    function onDragLeave() {
        this.style.borderColor = '#d9d9d9';
        this.style.background = '';
    }
    function onDrop(e) {
        e.preventDefault();
        this.style.borderColor = '#d9d9d9';
        this.style.background = '';
        processFile(e.dataTransfer.files && e.dataTransfer.files[0]);
    }

    $('#documentModal').on('shown.bs.modal', function () {

        // --- Col 1: Upload reader ---
        const reader = document.getElementById('documentReader');
        if (reader) {
            reader.settings = { copyright: false };
            reader.delegateProcessing = { serviceURL: BACKEND_URL };

            // Fix 7: remove before adding to prevent stacking
            const uploadLink = document.getElementById('uploadFileLink');
            uploadLink.removeEventListener('click', onUploadLinkClick);
            uploadLink.addEventListener('click', onUploadLinkClick);

            // Fix 5: remove before adding to prevent drag handler stacking
            const dragZone = document.getElementById('dragDropZone');
            if (dragZone) {
                dragZone.removeEventListener('dragover', onDragOver);
                dragZone.removeEventListener('dragleave', onDragLeave);
                dragZone.removeEventListener('drop', onDrop);
                dragZone.addEventListener('dragover', onDragOver);
                dragZone.addEventListener('dragleave', onDragLeave);
                dragZone.addEventListener('drop', onDrop);
            }

            reader.addEventListener('document-reader', (event) => {
                console.log('Upload reader event:', event.detail);
            });
        }

        // --- Col 2: Mobile reader (auto-shows QR) ---
        const mobileReader = document.getElementById('mobileReader');
        if (mobileReader) {
            mobileReader.settings = { copyright: false };
            mobileReader.delegateProcessing = {
                serviceURL: BACKEND_URL,
                delegateURL: BACKEND_URL + '?tag={tag}'
            };

            fetch(BACKEND_URL + '/api/v2/transaction/start', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: '{}'
            })
            .then(r => r.json())
            .then(data => {
                if (data.transactionId) {
                    mobileReader.transactionId = data.transactionId;
                    mobileReader.tag = data.tag;
                    // Fix 9: use MutationObserver instead of setTimeout
                    waitForShadowBtn(mobileReader, 'menu-from-mobile-button', btn => btn.click());
                }
            })
            .catch(console.error);

            mobileReader.addEventListener('document-reader', (event) => {
                console.log('Mobile reader event:', event.detail);
            });
        }

        // Fix 8: removed qrReader init — Col 3 is hidden, no point making API calls for it
    });

    $('#documentModal').on('hidden.bs.modal', function () {
        // Reset Col 1 reader
        const preview = document.getElementById('dragDropPreview');
        const defaultText = document.getElementById('dragDropDefault');
        if (preview) { preview.src = ''; preview.style.display = 'none'; }
        if (defaultText) defaultText.style.display = 'flex';
        const footer = document.getElementById('filePreviewFooter');
        const footerImg = document.getElementById('footerPreviewImg');
        if (footer) footer.style.display = 'none';
        if (footerImg) footerImg.src = '';
        const container = document.getElementById('regula-container');
        const reader = document.getElementById('documentReader');
        if (reader && container) {
            container.removeChild(reader);
            const newReader = document.createElement('document-reader');
            newReader.id = 'documentReader';
            newReader.setAttribute('locale', 'en');
            newReader.setAttribute('close-button', 'false');
            newReader.setAttribute('start-screen', 'true');
            newReader.delegateProcessing = { serviceURL: BACKEND_URL };
            newReader.setAttribute('license', LICENSE_KEY);
            newReader.style.cssText = 'display:block;width:100%;';
            container.appendChild(newReader);
        }

        // Reset Col 2 reader
        const mobileContainer = document.getElementById('mobile-container');
        const mobileReader = document.getElementById('mobileReader');
        if (mobileReader && mobileContainer) {
            mobileContainer.removeChild(mobileReader);
            const newMobileReader = document.createElement('document-reader');
            newMobileReader.id = 'mobileReader';
            newMobileReader.setAttribute('locale', 'en');
            newMobileReader.setAttribute('close-button', 'false');
            newMobileReader.setAttribute('start-screen', 'true');
            newMobileReader.setAttribute('mobile-delegate', 'true');
            newMobileReader.setAttribute('switch-to-mobile', 'true');
            newMobileReader.setAttribute('show-mobile-button', 'true');
            newMobileReader.delegateProcessing = {
                serviceURL: BACKEND_URL,
                delegateURL: BACKEND_URL + '?tag={tag}'
            };
            newMobileReader.setAttribute('license', LICENSE_KEY);
            newMobileReader.style.cssText = 'display:block;width:100%;';
            mobileContainer.appendChild(newMobileReader);
        }
        // Fix 6: removed Col 3 (qrReader) reset — it is hidden and never initialised
    });
});
