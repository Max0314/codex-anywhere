import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { canShareImage, shareImage } from './image-save';
import { formatBytes } from './image-utils';
import { t } from './i18n';

export function ImageSaveDialog({ file, onClose }: { file: File; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [url, setUrl] = useState('');
  const [sharing, setSharing] = useState(false);
  const [failed, setFailed] = useState(false);
  const supported = canShareImage(file);
  useEffect(() => {
    const imageUrl = URL.createObjectURL(file);
    setUrl(imageUrl);
    dialog.current?.showModal();
    return () => URL.revokeObjectURL(imageUrl);
  }, [file]);
  const save = () => {
    setSharing(true);
    setFailed(false);
    // Invoke synchronously inside the user's fresh click, after the transfer has finished.
    void shareImage(file).then(result => {
      if (result === 'unavailable') setFailed(true);
    }).catch(() => setFailed(true)).finally(() => setSharing(false));
  };
  return createPortal(
    <dialog ref={dialog} className="image-save-dialog" aria-labelledby="image-save-title"
      onCancel={event => { event.preventDefault(); onClose(); }}>
      <header>
        <div><strong id="image-save-title">{t('保存图片', 'Save image')}</strong><small>{file.name} · {formatBytes(file.size)}</small></div>
        <button type="button" onClick={onClose} aria-label={t('关闭保存图片', 'Close save image')}>×</button>
      </header>
      <div className="image-save-preview">{url && <img src={url} alt={file.name} />}</div>
      <footer>
        <p>{supported && !failed
          ? t('点击下方按钮，在系统菜单中选择「存储图像」。也可以长按原图保存。', 'Open the system menu and choose Save Image. You can also touch and hold the original image to save it.')
          : t('请长按上方原图，选择「存储到照片」。也可以下载原文件。', 'Touch and hold the original image above and choose Save to Photos, or download the original file.')}</p>
        {failed && <p role="status">{t('无法打开系统分享，请长按原图保存，或在 Safari 中打开本页。', 'Unable to open sharing. Touch and hold the image, or open this page in Safari.')}</p>}
        <div className="image-save-actions">
          {supported && <button type="button" className="image-save-primary" disabled={sharing} onClick={save}>
            {sharing ? t('分享菜单已打开…', 'Sharing…') : t('保存到相册／分享', 'Save to Photos / Share')}
          </button>}
          <a href={url || undefined} download={file.name}>{t('下载原图', 'Download original')}</a>
        </div>
      </footer>
    </dialog>, document.body,
  );
}
