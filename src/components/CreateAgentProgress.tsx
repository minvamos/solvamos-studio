import React from 'react';
import { Loader2, CheckCircle2, Circle } from 'lucide-react';

export type CreateStepId =
  | 'compile'
  | 'drive'
  | 'vertex'
  | 'catalog'
  | 'ready';

export type CreateStep = {
  id: CreateStepId;
  label: string;
  hint?: string;
};

export const CREATE_STEPS: CreateStep[] = [
  { id: 'compile', label: '시스템 프롬프트 · 에이전트 메타 조립', hint: '역할 / 톤 / 보안' },
  { id: 'drive', label: 'Google Drive RAG 주입', hint: '선택 폴더·문서 텍스트 수집' },
  { id: 'vertex', label: 'Vertex AI Search 데이터스토어 연결', hint: '인덱싱 ID 예약 / 검색 경로' },
  { id: 'catalog', label: 'pay.sh 카탈로그 게시', hint: 'A2A 디스커버리 · 가격' },
  { id: 'ready', label: '에이전트 기동 준비', hint: '샌드박스에서 바로 테스트' },
];

export const EDIT_STEPS: CreateStep[] = [
  { id: 'compile', label: '메타 · 요금 · 프롬프트 갱신', hint: '기존 ID / vault 유지' },
  { id: 'catalog', label: '카탈로그 목록 동기화', hint: '재게시가 아니라 메타 갱신' },
  { id: 'ready', label: '저장 완료', hint: '같은 에이전트로 바로 테스트' },
];

type Props = {
  open: boolean;
  /** 0..steps.length */
  activeIndex: number;
  percent: number;
  detail?: string | null;
  mode?: 'create' | 'edit';
};

export default function CreateAgentProgress({
  open,
  activeIndex,
  percent,
  detail,
  mode = 'create',
}: Props) {
  if (!open) return null;
  const pct = Math.max(4, Math.min(100, Math.round(percent)));
  const steps = mode === 'edit' ? EDIT_STEPS : CREATE_STEPS;
  const isEdit = mode === 'edit';

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="w-full max-w-md rounded-2xl border border-outline-variant/30 bg-surface-container-high shadow-2xl p-6">
        <div className="flex items-center gap-3 mb-5">
          <div className="relative">
            <Loader2 className="w-9 h-9 text-google-blue animate-spin" />
          </div>
          <div>
            <p className="text-lg font-semibold text-on-surface">
              {isEdit ? '에이전트 저장 중' : '에이전트 생성 중'}
            </p>
            <p className="text-xs text-on-surface-variant">
              {isEdit
                ? '기존 vault·ID를 유지한 채 메타만 업데이트합니다'
                : 'Drive RAG · Vertex · pay.sh 카탈로그까지 순차 처리합니다'}
            </p>
          </div>
        </div>

        <div className="h-2.5 w-full rounded-full bg-surface-container-lowest overflow-hidden mb-2">
          <div
            className="h-full rounded-full bg-gradient-to-r from-google-blue to-solana-green transition-all duration-500 ease-out"
            style={{ width: `${pct}%` }}
          />
        </div>
        <p className="text-right text-xs font-mono text-on-surface-variant mb-5">{pct}%</p>

        <ul className="space-y-3">
          {steps.map((s, i) => {
            const done = i < activeIndex;
            const current = i === activeIndex;
            return (
              <li key={s.id} className="flex items-start gap-3">
                {done ? (
                  <CheckCircle2 className="w-5 h-5 text-solana-green shrink-0 mt-0.5" />
                ) : current ? (
                  <Loader2 className="w-5 h-5 text-google-blue animate-spin shrink-0 mt-0.5" />
                ) : (
                  <Circle className="w-5 h-5 text-outline-variant shrink-0 mt-0.5" />
                )}
                <div>
                  <p
                    className={`text-sm font-medium ${
                      current ? 'text-on-surface' : done ? 'text-on-surface-variant' : 'text-outline'
                    }`}
                  >
                    {s.label}
                  </p>
                  {s.hint ? (
                    <p className="text-[11px] text-on-surface-variant/80">{s.hint}</p>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>

        {detail ? (
          <p className="mt-5 text-xs text-on-surface-variant border-t border-outline-variant/20 pt-3 font-mono break-all">
            {detail}
          </p>
        ) : null}
      </div>
    </div>
  );
}
