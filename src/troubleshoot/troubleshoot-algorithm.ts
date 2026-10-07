/**
 * 插件冲突排查 - 核心算法
 * 
 * 算法设计：
 * 1. 主循环二分缩小嫌疑集合
 * 2. 如果 Fail(C1) → 问题在左半
 * 3. 如果 Fail(C2) → 问题在右半
 * 4. 如果两半都 Pass → 跨分区冲突，调用 FindCrossPair
 * 5. FindCrossPair: 固定一侧全开，二分另一侧
 */

import { App, PluginManifest } from 'obsidian';
import Manager from 'main';
import { TroubleshootState, TroubleshootHistoryItem, AlgorithmState, CORE_PLUGINS_EXCLUDE } from './troubleshoot-state';

const cloneAlgorithmState = (algo: AlgorithmState): AlgorithmState => JSON.parse(JSON.stringify(algo));

export type AlgorithmResult =
    | { type: 'single'; culprit: string }
    | { type: 'pair'; culpritA: string; culpritB: string }
    | { type: 'not-plugin-issue' }
    | { type: 'continue'; nextAction: NextAction }
    | { type: 'error'; message: string };

export type NextAction =
    | { action: 'test'; plugins: string[]; description: string }
    | { action: 'confirm-initial' }
    | { action: 'done' };

/**
 * 排查算法管理器
 */
export class TroubleshootAlgorithm {
    private app: App;
    private manager: Manager;
    private bpmId: string;

    constructor(app: App, manager: Manager) {
        this.app = app;
        this.manager = manager;
        this.bpmId = manager.manifest.id; 
    }

    /** Installed plugins taking part in troubleshooting: everything except BPM itself. */
    private getCandidatePlugins(): string[] {
        return Object.keys(this.getAllManifests())
            .filter((id) => id !== this.bpmId && !CORE_PLUGINS_EXCLUDE.includes(id));
    }

    /**
     * 获取当前启用的插件列表（排除核心插件）
     */
    getEnabledPlugins(): string[] {
        return this.getCandidatePlugins().filter((id) => this.manager.pluginStartup.isWanted(id));
    }

    /**
     * 获取所有插件的 manifest
     */
    getAllManifests(): Record<string, PluginManifest> {
        // @ts-ignore
        return this.app.plugins.manifests;
    }

    /**
     * 启用指定插件集合（禁用其他所有插件）
     */
    async setEnabledPlugins(pluginsToEnable: string[]): Promise<void> {
        // Wanted state is persisted, so each step survives restarting Obsidian (which troubleshooting asks for).
        // Not user-initiated: switching plugins off here shouldn't close their panes.
        const enableSet = new Set(pluginsToEnable);
        const states: Record<string, boolean> = {};
        for (const id of this.getCandidatePlugins()) {
            const shouldEnable = enableSet.has(id);
            if (this.manager.pluginStartup.isWanted(id) !== shouldEnable || this.manager.pluginStartup.isLoaded(id) !== shouldEnable) {
                states[id] = shouldEnable;
            }
        }
        await this.manager.pluginStartup.setWantedMany(states);
    }

    /**
     * 将列表二分
     */
    splitHalf<T>(arr: T[]): [T[], T[]] {
        const mid = Math.ceil(arr.length / 2);
        return [arr.slice(0, mid), arr.slice(mid)];
    }

    /**
     * 初始化排查状态
     */
    initState(): TroubleshootState {
        const enabled = this.getEnabledPlugins();
        return {
            status: 'running',
            originalEnabledPlugins: [...enabled],
            phase: 'confirm',
            suspectPool: [...enabled],
            clearedPlugins: [],
            currentStep: 1,
            history: [],
            // 新增字段用于新算法
            algorithmState: {
                stage: 'initial-confirm',
                currentSet: [...enabled],
                fixedSet: [],
                searchSet: [],
                foundFirst: null,
            },
        };
    }

    /**
     * 在用户回答之前，为整个排查状态拍一张快照。
     *
     * 撤销需要同时回到"当时启用了哪些插件"和"算法走到了哪一步"，所以这里记录实际启用的插件
     * （而不是由各阶段自行传入，容易传错）以及完整的 algorithmState。
     */
    private snapshotBeforeAnswer(state: TroubleshootState, problemExists: boolean): TroubleshootHistoryItem {
        return {
            action: 'answer',
            previousEnabledPlugins: this.getEnabledPlugins(),
            userFeedback: problemExists ? 'problem-exists' : 'problem-gone',
            suspectPoolSnapshot: [...state.suspectPool],
            algorithmState: state.algorithmState ? cloneAlgorithmState(state.algorithmState) : undefined,
            currentStep: state.currentStep,
            currentTestDescription: state.currentTestDescription,
        };
    }

    /**
     * 撤销上一次回答：恢复当时启用的插件、算法状态与步骤说明。
     */
    async undo(state: TroubleshootState): Promise<boolean> {
        if (state.history.length === 0) return false;

        const lastStep = state.history.pop()!;
        await this.setEnabledPlugins(lastStep.previousEnabledPlugins);
        state.suspectPool = lastStep.suspectPoolSnapshot;

        if (lastStep.algorithmState) {
            state.algorithmState = cloneAlgorithmState(lastStep.algorithmState);
            state.currentStep = lastStep.currentStep ?? Math.max(1, state.currentStep - 1);
            state.currentTestDescription = lastStep.currentTestDescription;
        } else {
            // 旧版本保存的历史没有算法快照，只能回退插件状态。
            state.currentStep = Math.max(1, state.currentStep - 1);
        }

        return true;
    }

    /**
     * 恢复原始状态
     */
    async restoreOriginal(state: TroubleshootState): Promise<void> {
        await this.setEnabledPlugins(state.originalEnabledPlugins);
    }

    // ========================================
    // 新算法实现
    // ========================================

    /**
     * 执行下一步排查
     * 根据用户反馈（问题是否存在）推进算法
     */
    async executeNextStep(
        state: TroubleshootState,
        problemExists: boolean
    ): Promise<AlgorithmResult> {
        const snapshot = this.snapshotBeforeAnswer(state, problemExists);
        const result = await this.dispatchAnswer(state, problemExists);
        if (result.type === 'continue') {
            state.history.push(snapshot);
            if (result.nextAction.action === 'test') {
                state.currentTestDescription = result.nextAction.description;
            }
        }
        return result;
    }

    private async dispatchAnswer(
        state: TroubleshootState,
        problemExists: boolean
    ): Promise<AlgorithmResult> {
        const algo = state.algorithmState!;

        switch (algo.stage) {
            case 'initial-confirm':
                return this.handleInitialConfirm(state, problemExists);

            case 'bisect-main':
                return this.handleBisectMain(state, problemExists);

            case 'cross-pair-bisect-b':
                return this.handleCrossPairBisectB(state, problemExists);

            case 'cross-pair-bisect-a':
                return this.handleCrossPairBisectA(state, problemExists);

            case 'verify-single':
                return this.handleVerifySingle(state, problemExists);

            case 'verify-pair':
                return this.handleVerifyPair(state, problemExists);

            default:
                return { type: 'error', message: this.manager.translator.t('排查_错误_未知阶段') };
        }
    }

    /**
     * 阶段：初始确认（禁用全部插件）
     */
    private async handleInitialConfirm(
        state: TroubleshootState,
        problemExists: boolean
    ): Promise<AlgorithmResult> {
        if (problemExists) {
            // 禁用所有插件后问题还在 → 不是插件问题
            return { type: 'not-plugin-issue' };
        }

        // 问题消失，是插件问题，开始主循环
        const algo = state.algorithmState!;
        algo.stage = 'bisect-main';
        algo.currentSet = [...state.originalEnabledPlugins];
        state.currentStep++;

        // 0–2 个插件时无需二分，直接进入验证（或报告无法定位）
        if (algo.currentSet.length <= 2) {
            return this.continueOrFinishBisect(state, false);
        }

        // 启用前半测试
        const [c1] = this.splitHalf(algo.currentSet);
        algo.testingHalf = 'first';
        algo.c1 = c1;
        algo.c2 = algo.currentSet.filter(id => !c1.includes(id));

        await this.setEnabledPlugins(c1);

        return {
            type: 'continue',
            nextAction: {
                action: 'test',
                plugins: c1,
                description: this.manager.translator.t('排查_描述_测试前半').replace('{count}', c1.length.toString())
            }
        };
    }

    /**
     * 阶段：主循环二分
     */
    private async handleBisectMain(
        state: TroubleshootState,
        problemExists: boolean
    ): Promise<AlgorithmResult> {
        const algo = state.algorithmState!;
        state.currentStep++;

        if (algo.testingHalf === 'first') {
            // 刚测试了 C1
            if (problemExists) {
                // 问题在 C1，缩小范围（此时恰好只启用了 C1）
                algo.currentSet = algo.c1!;
                return this.continueOrFinishBisect(state, true);
            } else {
                // C1 没问题，测试 C2
                algo.testingHalf = 'second';
                await this.setEnabledPlugins(algo.c2!);

                return {
                    type: 'continue',
                    nextAction: {
                        action: 'test',
                        plugins: algo.c2!,
                        description: this.manager.translator.t('排查_描述_测试后半').replace('{count}', algo.c2!.length.toString())
                    }
                };
            }
        } else {
            // 刚测试了 C2
            if (problemExists) {
                // 问题在 C2，缩小范围（此时恰好只启用了 C2）
                algo.currentSet = algo.c2!;
                return this.continueOrFinishBisect(state, true);
            } else {
                // C1 和 C2 都没问题 → 跨分区冲突！
                return this.startCrossPair(state, algo.c1!, algo.c2!);
            }
        }
    }

    /**
     * 继续二分或完成
     *
     * @param failedWithExactlyCurrentSet 刚才的测试中是否恰好只启用了 currentSet 且问题存在。
     *   为 true 且只剩一个插件时，它已经被单独验证过，无需再测一次。
     */
    private async continueOrFinishBisect(state: TroubleshootState, failedWithExactlyCurrentSet: boolean): Promise<AlgorithmResult> {
        const algo = state.algorithmState!;

        if (algo.currentSet.length === 0) {
            return { type: 'error', message: this.manager.translator.t('排查_无法定位_通知') };
        }

        if (algo.currentSet.length === 1 && failedWithExactlyCurrentSet) {
            algo.foundFirst = algo.currentSet[0];
            state.result = { plugin1: algo.foundFirst, plugin2: '' };
            state.status = 'completed';
            state.phase = 'done';
            return { type: 'single', culprit: algo.foundFirst };
        }

        if (algo.currentSet.length === 1) {
            // 只剩一个，验证是否是单插件问题
            algo.stage = 'verify-single';
            algo.foundFirst = algo.currentSet[0];

            await this.setEnabledPlugins([algo.foundFirst]);

            return {
                type: 'continue',
                nextAction: {
                    action: 'test',
                    plugins: [algo.foundFirst],
                    description: this.manager.translator.t('排查_描述_验证单插件').replace('{name}', this.getPluginName(algo.foundFirst))
                }
            };
        }

        if (algo.currentSet.length === 2) {
            // 剩两个，需要判断是单个问题还是组合冲突
            // 先测试第一个
            algo.stage = 'verify-pair';
            algo.pairToVerify = [...algo.currentSet];
            algo.verifyStep = 'test-first';

            await this.setEnabledPlugins([algo.currentSet[0]]);

            return {
                type: 'continue',
                nextAction: {
                    action: 'test',
                    plugins: [algo.currentSet[0]],
                    description: this.manager.translator.t('排查_描述_验证').replace('{name}', this.getPluginName(algo.currentSet[0]))
                }
            };
        }

        // 继续二分
        const [c1, c2] = this.splitHalf(algo.currentSet);
        algo.testingHalf = 'first';
        algo.c1 = c1;
        algo.c2 = c2;

        await this.setEnabledPlugins(c1);

        return {
            type: 'continue',
            nextAction: {
                action: 'test',
                plugins: c1,
                description: this.manager.translator.t('排查_描述_测试前半').replace('{count}', c1.length.toString())
            }
        };
    }

    /**
     * 开始跨分区冲突排查
     */
    private async startCrossPair(
        state: TroubleshootState,
        setA: string[],
        setB: string[]
    ): Promise<AlgorithmResult> {
        const algo = state.algorithmState!;

        algo.stage = 'cross-pair-bisect-b';
        algo.fixedSet = setA;  // 固定 A 全开
        algo.searchSet = setB; // 在 B 中搜索

        // 固定 A，二分 B
        const [b1] = this.splitHalf(algo.searchSet);
        algo.searchHalf = b1;
        algo.searchOtherHalf = algo.searchSet.filter(id => !b1.includes(id));

        const testSet = [...algo.fixedSet, ...b1];
        await this.setEnabledPlugins(testSet);

        state.currentStep++;

        return {
            type: 'continue',
            nextAction: {
                action: 'test',
                plugins: testSet,
                description: this.manager.translator.t('排查_描述_固定A测试B前').replace('{countA}', algo.fixedSet.length.toString()).replace('{countB}', b1.length.toString())
            }
        };
    }

    /**
     * 阶段：跨分区二分 B
     */
    private async handleCrossPairBisectB(
        state: TroubleshootState,
        problemExists: boolean
    ): Promise<AlgorithmResult> {
        const algo = state.algorithmState!;
        state.currentStep++;

        if (problemExists) {
            // 问题在当前测试的半边
            algo.searchSet = algo.searchHalf!;
        } else {
            // 问题在另一半
            algo.searchSet = algo.searchOtherHalf!;
        }

        if (algo.searchSet.length === 1) {
            // 找到 b*
            algo.foundSecond = algo.searchSet[0];

            // 开始在 A 中搜索 a*
            algo.stage = 'cross-pair-bisect-a';
            algo.searchSet = algo.fixedSet;
            algo.fixedSet = [algo.foundSecond];

            const [a1] = this.splitHalf(algo.searchSet);
            algo.searchHalf = a1;
            algo.searchOtherHalf = algo.searchSet.filter(id => !a1.includes(id));

            const testSet = [...algo.fixedSet, ...a1];
            await this.setEnabledPlugins(testSet);

            return {
                type: 'continue',
                nextAction: {
                    action: 'test',
                    plugins: testSet,
                    description: this.manager.translator.t('排查_描述_固定B测试A前').replace('{countB}', algo.fixedSet.length.toString()).replace('{countA}', a1.length.toString())
                }
            };
        }

        // 继续二分 B
        const [b1] = this.splitHalf(algo.searchSet);
        algo.searchHalf = b1;
        algo.searchOtherHalf = algo.searchSet.filter(id => !b1.includes(id));

        const testSet = [...algo.fixedSet, ...b1];
        await this.setEnabledPlugins(testSet);

        return {
            type: 'continue',
            nextAction: {
                action: 'test',
                plugins: testSet,
                description: this.manager.translator.t('排查_描述_固定A测试B前').replace('{countA}', algo.fixedSet.length.toString()).replace('{countB}', b1.length.toString())
            }
        };
    }

    /**
     * 阶段：跨分区二分 A
     */
    private async handleCrossPairBisectA(
        state: TroubleshootState,
        problemExists: boolean
    ): Promise<AlgorithmResult> {
        const algo = state.algorithmState!;
        state.currentStep++;

        if (problemExists) {
            algo.searchSet = algo.searchHalf!;
        } else {
            algo.searchSet = algo.searchOtherHalf!;
        }

        if (algo.searchSet.length === 1) {
            // 找到 a*
            algo.foundFirst = algo.searchSet[0];

            // 完成！返回冲突对
            state.result = {
                plugin1: algo.foundFirst,
                plugin2: algo.foundSecond!,
            };
            state.status = 'completed';
            state.phase = 'done';

            return {
                type: 'pair',
                culpritA: algo.foundFirst,
                culpritB: algo.foundSecond!
            };
        }

        // 继续二分 A
        const [a1] = this.splitHalf(algo.searchSet);
        algo.searchHalf = a1;
        algo.searchOtherHalf = algo.searchSet.filter(id => !a1.includes(id));

        const testSet = [...algo.fixedSet, ...a1];
        await this.setEnabledPlugins(testSet);

        return {
            type: 'continue',
            nextAction: {
                action: 'test',
                plugins: testSet,
                description: this.manager.translator.t('排查_描述_固定B测试A前').replace('{countB}', algo.fixedSet.length.toString()).replace('{countA}', a1.length.toString())
            }
        };
    }

    /**
     * 阶段：验证单插件
     */
    private async handleVerifySingle(
        state: TroubleshootState,
        problemExists: boolean
    ): Promise<AlgorithmResult> {
        const algo = state.algorithmState!;

        if (problemExists) {
            // 确认是单插件问题
            state.result = {
                plugin1: algo.foundFirst!,
                plugin2: '', // 单插件没有第二个
            };
            state.status = 'completed';
            state.phase = 'done';

            return {
                type: 'single',
                culprit: algo.foundFirst!
            };
        } else {
            // 单个插件没问题，可能是更复杂的情况
            return {
                type: 'error',
                message: this.manager.translator.t('排查_无法定位_通知')
            };
        }
    }

    /**
     * 阶段：验证冲突对（剩两个插件时）
     */
    private async handleVerifyPair(
        state: TroubleshootState,
        problemExists: boolean
    ): Promise<AlgorithmResult> {
        const algo = state.algorithmState!;
        const pair = algo.pairToVerify!;
        state.currentStep++;

        if (algo.verifyStep === 'test-first') {
            if (problemExists) {
                // 第一个单独就有问题
                state.result = { plugin1: pair[0], plugin2: '' };
                state.status = 'completed';
                state.phase = 'done';
                return { type: 'single', culprit: pair[0] };
            }

            // 第一个没问题，测试第二个
            algo.verifyStep = 'test-second';
            await this.setEnabledPlugins([pair[1]]);

            return {
                type: 'continue',
                nextAction: {
                    action: 'test',
                    plugins: [pair[1]],
                    description: this.manager.translator.t('排查_描述_验证', { name: this.getPluginName(pair[1]) })
                }
            };
        }

        if (algo.verifyStep === 'test-second') {
            if (problemExists) {
                // 第二个单独就有问题
                state.result = { plugin1: pair[1], plugin2: '' };
                state.status = 'completed';
                state.phase = 'done';
                return { type: 'single', culprit: pair[1] };
            }

            // 两个单独都没问题，确认是冲突对
            state.result = { plugin1: pair[0], plugin2: pair[1] };
            state.status = 'completed';
            state.phase = 'done';
            return { type: 'pair', culpritA: pair[0], culpritB: pair[1] };
        }

        return { type: 'error', message: this.manager.translator.t('排查_错误_状态异常') };
    }

    /**
     * 开始排查（第一步：禁用全部）
     */
    async startTroubleshoot(state: TroubleshootState): Promise<void> {
        const algo = state.algorithmState!;
        algo.stage = 'initial-confirm';
        state.currentTestDescription = this.manager.translator.t('排查_描述_禁用全部');

        // 第一步不进入撤销历史：想回到开始之前，用"恢复并退出"。
        await this.setEnabledPlugins([]);
    }

    /**
     * 获取插件显示名称
     */
    getPluginName(id: string): string {
        const manifests = this.getAllManifests();
        return manifests[id]?.name || id;
    }

    /**
     * 计算预计剩余步骤数
     */
    estimateRemainingSteps(state: TroubleshootState): number {
        const poolSize = state.algorithmState?.currentSet?.length || state.suspectPool.length;
        if (poolSize <= 1) return 1;
        // 最坏情况：2 * log2(n)
        return Math.ceil(Math.log2(poolSize)) * 2;
    }

    /**
     * 重启 Obsidian
     */
    restartObsidian(): void {
        // @ts-ignore
        this.app.commands.executeCommandById('app:reload');
    }
}
