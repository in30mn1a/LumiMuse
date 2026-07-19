'use client';

import { useEffect, useRef, useState } from 'react';
import {
  DEFAULT_IMAGE_ASPECT_RATIO,
  peekImageAspectRatio,
  rememberImageAspectRatio,
  warmImageAspectRatio,
} from '@/lib/image-aspect-cache';
import {
  isInMemoryImageSrc,
  peekImageBlobUrl,
  warmImageBlob,
} from '@/lib/image-blob-cache';

interface Props {
  src?: string;
  alt?: string;
  /** 附加到外层占位容器 */
  className?: string;
  /** 最大宽度类名，默认聊天生图卡 max-w-[20rem] */
  maxWidthClassName?: string;
  /** 最大高度（CSS 长度），用于用户附件等场景；不设则仅受宽度约束 */
  maxHeight?: string;
  onClick?: (e: React.MouseEvent<HTMLImageElement>) => void;
}

/**
 * 带宽高比占位 + 内存 blob 的聊天图片：
 * - aspect-ratio 占位：虚拟列表 remeasure 不跳
 * - blob object URL：切对话 remount 时尽量从内存秒开
 * - 已 warm / 已 complete 的图不走透明淡入，避免「有缓存还闪一下」
 *
 * 外层按 src 作 key 重挂载内层：「src 变化重置状态」交给 React key 机制，
 * 避免在 effect 里同步 setState（react-hooks/set-state-in-effect）。
 */
export default function ReservedChatImage(props: Props) {
  if (!props.src) return null;
  return <ReservedChatImageInner key={props.src} {...props} src={props.src} />;
}

function ReservedChatImageInner({
  src,
  alt = '',
  className = '',
  maxWidthClassName = 'max-w-[20rem]',
  maxHeight,
  onClick,
}: Props & { src: string }) {
  const [ratio, setRatio] = useState(() => peekImageAspectRatio(src) ?? DEFAULT_IMAGE_ASPECT_RATIO);
  const [displaySrc, setDisplaySrc] = useState(() => peekImageBlobUrl(src) || src);
  const [loaded, setLoaded] = useState(
    () => Boolean(peekImageBlobUrl(src)) || isInMemoryImageSrc(src) || peekImageAspectRatio(src) != null,
  );
  /** 已锁定真实比例后，不再被默认值/慢 warm 覆盖，避免二次跳动 */
  const lockedRef = useRef(peekImageAspectRatio(src) != null);
  const imgRef = useRef<HTMLImageElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    const expectedSrc = peekImageBlobUrl(src) || src;

    // 下一帧检查 img 是否已 complete（HTTP 磁盘缓存命中时同步可用），立即亮起免淡入。
    // 校验 DOM src 仍是本轮期望值，防止把旧图比率记到新 URL 名下。
    const raf = requestAnimationFrame(() => {
      const el = imgRef.current;
      if (cancelled || !el || el.getAttribute('src') !== expectedSrc) return;
      if (!el.complete || el.naturalWidth <= 0) return;
      const r = el.naturalWidth / el.naturalHeight;
      rememberImageAspectRatio(src, r);
      lockedRef.current = true;
      setRatio(r);
      setLoaded(true);
    });

    const hasBlob = Boolean(peekImageBlobUrl(src)) || isInMemoryImageSrc(src);
    if (!hasBlob) {
      // 后台灌内存，供下次 remount 秒开。
      // 本轮若远程 img 已 complete，不替换 src，避免二次闪烁。
      void warmImageBlob(src).then((objectUrl) => {
        if (cancelled || !objectUrl) return;
        if (imgRef.current?.complete && imgRef.current.naturalWidth > 0) {
          setLoaded(true);
          return;
        }
        setDisplaySrc(objectUrl);
        setLoaded(true);
      });
    }

    // data:/blob: 不进宽高比缓存（键太大/临时），由 onLoad 就地设置
    if (!lockedRef.current && !isInMemoryImageSrc(src)) {
      void warmImageAspectRatio(src).then((r) => {
        if (cancelled || lockedRef.current) return;
        setRatio(r);
        lockedRef.current = true;
      });
    }

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [src]);

  // maxHeight 生效时（竖图/方图），让容器宽度跟随比率收窄为 maxHeight*ratio，
  // 避免 aspect-ratio 被 max-height 压过后出现左右 letterbox 灰带（圆角/ring 需贴图片）
  const sizeStyle: React.CSSProperties = {
    aspectRatio: String(ratio),
    ...(maxHeight
      ? { maxHeight, width: `min(100%, calc(${maxHeight} * ${ratio}))` }
      : null),
  };

  return (
    <div
      className={`relative w-full overflow-hidden bg-black/[0.04] dark:bg-white/[0.06] ${maxWidthClassName} ${className}`}
      style={sizeStyle}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- 用户/生图 URL 动态，走同源 /api/files 或 blob: */}
      <img
        ref={imgRef}
        src={displaySrc}
        alt={alt}
        loading="eager"
        decoding="async"
        draggable={false}
        onClick={onClick}
        className={`absolute inset-0 h-full w-full object-contain transition-opacity duration-100 ${
          loaded ? 'opacity-100' : 'opacity-0'
        }`}
        onLoad={(e) => {
          const el = e.currentTarget;
          if (el.naturalWidth > 0 && el.naturalHeight > 0) {
            const r = el.naturalWidth / el.naturalHeight;
            rememberImageAspectRatio(src, r);
            if (!lockedRef.current) {
              lockedRef.current = true;
              setRatio(r);
            }
          }
          setLoaded(true);
          // 首次从网络/磁盘 decode 成功后灌入内存 blob，供下次切对话秒开
          if (!isInMemoryImageSrc(src) && !peekImageBlobUrl(src)) {
            void warmImageBlob(src);
          }
        }}
        onError={() => {
          // blob 被淘汰 revoke / 加载失败：回退原始 URL 重试一次；
          // 已在原始 URL 上失败则露出浏览器破图态，而非永久 opacity-0 空盒
          if (displaySrc !== src) {
            setDisplaySrc(src);
          } else {
            setLoaded(true);
          }
        }}
      />
    </div>
  );
}
