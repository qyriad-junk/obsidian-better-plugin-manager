/**
 * 插件冲突排查 - 状态管理
 */

export interface TroubleshootState {
    /** 排查状态 */
    status: 'idle' | 'running' | 'completed' | 'aborted';

    /** 原始启用的插件列表（用于最后恢复） */
    originalEnabledPlugins: string[];

    /** 当前阶段 */
    phase: 'confirm' | 'find-first' | 'find-second' | 'done';

    /** 嫌疑池（待测试的插件） */
    suspectPool: string[];

    /** 已排除的插件 */
    clearedPlugins: string[];

    /** 第一个确认的冲突插件（Phase 3 使用） */
    firstConflictPlugin?: string;

    /** 当前步骤 */
    currentStep: number;

    /** 操作历史（支持撤销） */
    history: TroubleshootHistoryItem[];

    /** 最终结果 */
    result?: {
        plugin1: string;
        plugin2: string;
    };

    /** 新算法状态 */
    algorithmState?: AlgorithmState;

    /** 当前这一步要用户测试的内容说明（持久化，以便撤销或重启 Obsidian 后仍能显示） */
    currentTestDescription?: string;
}

export interface AlgorithmState {
    /** 当前算法阶段 */
    stage: 'initial-confirm' | 'bisect-main' | 'cross-pair-bisect-b' | 'cross-pair-bisect-a' | 'verify-single' | 'verify-pair';

    /** 当前嫌疑集合 */
    currentSet: string[];

    /** 固定启用的集合（跨分区排查时） */
    fixedSet: string[];

    /** 被搜索的集合（跨分区排查时） */
    searchSet: string[];

    /** 找到的第一个冲突插件 */
    foundFirst: string | null;

    /** 找到的第二个冲突插件 */
    foundSecond?: string;

    /** 当前测试的是哪一半 */
    testingHalf?: 'first' | 'second';

    /** C1 集合 */
    c1?: string[];

    /** C2 集合 */
    c2?: string[];

    /** 当前搜索的半边 */
    searchHalf?: string[];

    /** 另一半 */
    searchOtherHalf?: string[];

    /** 待验证的对 */
    pairToVerify?: string[];

    /** 验证步骤 */
    verifyStep?: 'test-first' | 'test-second';
}

export interface TroubleshootHistoryItem {
    /**
     * 'answer'：用户回答一次之前的完整快照（当前算法使用）。
     * 其余取值来自旧版本保存的排查进度，仅用于兼容读取。
     */
    action: 'answer' | 'disable-all' | 'enable-half' | 'disable-half' | 'isolate' | 'test-pair';
    /** 操作前实际启用的插件 */
    previousEnabledPlugins: string[];
    /** 用户反馈 */
    userFeedback?: 'problem-exists' | 'problem-gone';
    /** 当时的嫌疑池 */
    suspectPoolSnapshot: string[];
    /** 回答之前的算法状态；撤销时整体恢复。旧版本保存的历史没有此字段。 */
    algorithmState?: AlgorithmState;
    /** 回答之前的步骤编号 */
    currentStep?: number;
    /** 回答之前显示的测试说明 */
    currentTestDescription?: string;
}

/** 默认排除的核心插件（不参与排查） */
export const CORE_PLUGINS_EXCLUDE = [
    'better-plugins-manager',  // BPM 自身
];

/** 初始状态 */
export const INITIAL_TROUBLESHOOT_STATE: TroubleshootState = {
    status: 'idle',
    originalEnabledPlugins: [],
    phase: 'confirm',
    suspectPool: [],
    clearedPlugins: [],
    currentStep: 0,
    history: [],
};

/**
 * 深拷贝状态
 */
export function cloneState(state: TroubleshootState): TroubleshootState {
    return JSON.parse(JSON.stringify(state));
}
