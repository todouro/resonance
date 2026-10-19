import { useEffect, useRef } from 'react'
import type { CSSProperties, RefObject } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { HugeiconsIcon } from '@hugeicons/react'
import { VolumeHighIcon, VolumeLowIcon } from '@hugeicons/core-free-icons'
import type { Howl } from 'howler'
import ElasticSlider from './ElasticSlider'
import {
  DiscFilled,
  PauseFilled,
  PlayFilled,
  RepeatFilled,
  RepeatOneFilled,
  ShuffleFilled,
  SkipBackFilled,
  SkipForwardFilled,
} from './icons'
import { cleanDisplayTitle, formatTime } from '../utils/library'
import type { Track } from '../types'

export type PlayerBarProps = {
  currentTrack?: Track
  isPlaying: boolean
  audioRef: RefObject<Howl | null>
  seek: number
  shuffle: boolean
  repeat: string
  volume: number
  onTogglePlay: () => void
  onPrevious: () => void
  onNext: () => void
  onSeek: (value: number) => void
  onShuffle: () => void
  onRepeat: () => void
  onVolume: (value: number) => void
}

export function PlayerBar({
  currentTrack,
  isPlaying,
  audioRef,
  seek,
  shuffle,
  repeat,
  volume,
  onTogglePlay,
  onPrevious,
  onNext,
  onSeek,
  onShuffle,
  onRepeat,
  onVolume,
}: PlayerBarProps) {
  const duration = currentTrack?.duration ?? 0

  // Keep playback position out of React state while audio is advancing.
  // ElasticSlider reads this ref directly and animates its own DOM at frame rate.
  const progressValueRef = useRef(seek)
  const timeLabelRef = useRef<HTMLSpanElement>(null)
  const rafRef = useRef<number | null>(null)

  useEffect(() => {
    progressValueRef.current = Math.max(0, Math.min(duration || 0, seek))
    if (timeLabelRef.current) timeLabelRef.current.textContent = formatTime(seek)
  }, [seek, duration, currentTrack?.id])

  useEffect(() => {
    const readPosition = () => {
      const howl = audioRef.current
      if (!howl) return
      const position = howl.seek()
      if (typeof position !== 'number' || Number.isNaN(position)) return
      const clampedPosition = duration > 0 ? Math.min(Math.max(0, position), duration) : 0
      progressValueRef.current = clampedPosition
      const second = Math.floor(clampedPosition)
      if (timeLabelRef.current && timeLabelRef.current.dataset.second !== String(second)) {
        timeLabelRef.current.dataset.second = String(second)
        timeLabelRef.current.textContent = formatTime(clampedPosition)
      }
    }

    if (!isPlaying) {
      readPosition()
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
      return
    }

    const loop = () => {
      readPosition()
      rafRef.current = requestAnimationFrame(loop)
    }
    rafRef.current = requestAnimationFrame(loop)
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
    }
  }, [isPlaying, audioRef, duration])


  return (
    <footer className="player-bar">
      {/* 1. Track Info on Left */}
      <div className="player-track">
        <div
          className="mini-cover large"
          style={{ '--cover-accent': currentTrack?.accent } as CSSProperties}
        >
          {currentTrack?.coverUrl ? (
            <img src={currentTrack.coverUrl} alt="" />
          ) : (
            <DiscFilled size={22} />
          )}
        </div>
        <div>
          <strong>
            {currentTrack ? cleanDisplayTitle(currentTrack.title) : 'No track selected'}
          </strong>
          <span>{currentTrack?.artist ?? 'Choose a song to start'}</span>
        </div>
      </div>

      {/* 2. Center Transport Controls & Modern Scrubber */}
      <div className="transport">
        <div className="transport-buttons">
          <button
            className={shuffle ? 'control active' : 'control'}
            type="button"
            onClick={onShuffle}
            aria-label="Toggle shuffle"
          >
            <ShuffleFilled size={18} />
          </button>
          <button
            className="control"
            type="button"
            onClick={onPrevious}
            aria-label="Previous track"
          >
            <SkipBackFilled size={20} />
          </button>
          <button
            className="play-button"
            type="button"
            onClick={onTogglePlay}
            aria-label={isPlaying ? 'Pause' : 'Play'}
          >
            <AnimatePresence mode="wait" initial={false}>
              <motion.span
                key={isPlaying ? 'pause' : 'play'}
                initial={{ opacity: 0, rotate: -18, scale: 0.78 }}
                animate={{ opacity: 1, rotate: 0, scale: 1 }}
                exit={{ opacity: 0, rotate: 18, scale: 0.78 }}
                transition={{ type: 'spring', stiffness: 480, damping: 26 }}
                style={{ display: 'grid', placeItems: 'center' }}
              >
                {isPlaying ? <PauseFilled size={24} /> : <PlayFilled size={24} />}
              </motion.span>
            </AnimatePresence>
          </button>
          <button
            className="control"
            type="button"
            onClick={onNext}
            aria-label="Next track"
          >
            <SkipForwardFilled size={20} />
          </button>
          <button
            className={repeat !== 'off' ? 'control active' : 'control'}
            type="button"
            onClick={onRepeat}
            aria-label="Cycle repeat mode"
          >
            {repeat === 'one' ? <RepeatOneFilled size={18} /> : <RepeatFilled size={18} />}
          </button>
        </div>

        {/* React Bits ElasticSlider playback timeline */}
        <div className="progress-line">
          <div className="modern-scrubber-row">
            <span ref={timeLabelRef} className="scrubber-timestamp current">
              {formatTime(seek)}
            </span>
            <ElasticSlider
              value={Math.max(0, Math.min(duration || 0, seek))}
              valueSourceRef={progressValueRef}
              animateValueSource={isPlaying}
              onChange={onSeek}
              onChangeEnd={onSeek}
              startingValue={0}
              maxValue={Math.max(1, duration)}
              isStepped
              stepSize={1}
              formatValue={formatTime}
              valuePosition="bubble"
              ariaLabel="Playback progress"
              disabled={duration <= 0}
              leftIcon={null}
              rightIcon={null}
              trackColor="rgba(255, 255, 255, 0.14)"
              rangeColor="var(--neutral-accent, #f2f4f7)"
              contentColor="var(--muted)"
              style={{ flex: 1, minWidth: 0, width: '100%' }}
            />
            <span className="scrubber-timestamp total">{formatTime(duration)}</span>
          </div>
        </div>
      </div>

      {/* 3. Brand-new Modern Volume Controller on Right */}
      <div className="volume">
        <ElasticSlider
          value={Math.round(volume * 100)}
          onChange={(value) => onVolume(value / 100)}
          leftIcon={<HugeiconsIcon icon={VolumeLowIcon} size={20} strokeWidth={1.75} />}
          rightIcon={<HugeiconsIcon icon={VolumeHighIcon} size={20} strokeWidth={1.75} />}
          valuePosition="none"
          isStepped
          stepSize={1}
          ariaLabel="Volume"
          trackColor="rgba(255, 255, 255, 0.14)"
          rangeColor="var(--neutral-accent, #f2f4f7)"
          iconColor="var(--muted)"
          style={{ width: '100%' }}
        />
      </div>
    </footer>
  )
}

export default PlayerBar
