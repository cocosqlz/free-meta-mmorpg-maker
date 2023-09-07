import { Camera, Color, Component, EditBox, instantiate, Label, Node, Prefab, Quat, RichText, tween, TweenSystem, Vec2, _decorator, find } from 'cc';
import { WsClientStatus } from 'tsrpc-base-client';
import { WsClient } from 'tsrpc-browser';
import { Player } from './prefabs/Player/Player';
import { PlayerName } from './prefabs/PlayerName/PlayerName';
import { NetUtil } from '../scripts/models/NetUtil';
import { tgxEasyController, tgxEasyControllerEvent, tgxThirdPersonCameraCtrl, tgxUIAlert } from '../../core_tgx/tgx';
import { ResJoinSubWorld } from '../scripts/shared/protocols/worldServer/PtlJoinSubWorld';
import { ServiceType } from '../scripts/shared/protocols/serviceProto_masterServer';
import { SubWorldData } from '../scripts/shared/types/SubWorldData';
import { SubWorldUserState } from '../scripts/shared/types/SubWorldUserState';
import { UserInfo } from '../scripts/shared/types/UserInfo';
import { SceneDef, SceneUtil } from '../../scripts/SceneDef';
import { UserMgr } from '../../module_basic/scripts/UserMgr';
const { ccclass, property } = _decorator;

const q4_1 = new Quat;
const v2_1 = new Vec2;

export interface SubWorldSceneParams {
    worldServerUrl: string,
    token: string,
    time: number,
}

@ccclass('SubWorldScene')
export class SubWorldScene extends Component {

    params!: SubWorldSceneParams;
    client!: WsClient<ServiceType>;
    selfPlayer?: Player
    currentUser?: UserInfo;
    subWorldData!: SubWorldData;

    @property(Node)
    players!: Node;
    @property(Node)
    chatMsgs!: Node;
    @property(tgxThirdPersonCameraCtrl)
    followCamera!: tgxThirdPersonCameraCtrl;
    @property(EditBox)
    inputChat!: EditBox;
    @property(Node)
    playerNames!: Node;
    @property(Label)
    labelRoomName!: Label;
    @property(Label)
    labelRoomState!: Label;
    @property(Label)
    labelServerUrl!: Label;

    @property(Prefab)
    prefabPlayer!: Prefab;
    @property(Prefab)
    prefabChatMsgItem!: Prefab;
    @property(Prefab)
    prefabPlayerName!: Prefab;

    onLoad() {
        this.params = SceneUtil.sceneParams as SubWorldSceneParams;

        // Clean
        this.labelRoomName.string = this.labelRoomState.string = '';
        this.labelServerUrl.string = this.params.worldServerUrl;

        // Init
        this._initClient();

        // 开始连接
        this._ensureConnected();

        // 定时刷新右上角房间状态
        this.schedule(() => { this._resetSubWorldState() }, 3)
        this._resetSubWorldState()

        // 定时向服务器上报状态
        this.schedule(() => {
            if (!this.selfPlayer) {
                return;
            }
            this.client.sendMsg('clientMsg/UserState', {
                aniState: this.selfPlayer.aniState,
                pos: this.selfPlayer.node.position,
                rotation: this.selfPlayer.node.rotation
            })
        }, 0.1);

        tgxEasyController.on(tgxEasyControllerEvent.MOVEMENT, this.onMovement, this);
        tgxEasyController.on(tgxEasyControllerEvent.MOVEMENT_STOP, this.onMovmentStop, this);
    }

    onMovement(degree: number, strengthen: number) {
        if (!this.selfPlayer) {
            return;
        }
        this.selfPlayer.aniState = 'walking';
        this.selfPlayer.node.setWorldRotationFromEuler(0, degree + this.followCamera.node.eulerAngles.y + 90, 0);
    }

    onMovmentStop() {
        if (!this.selfPlayer) {
            return;
        }
        this.selfPlayer.aniState = 'idle';
    }

    private _initClient() {
        this.client = NetUtil.createWorldClient(this.params.worldServerUrl);

        this.client.listenMsg('serverMsg/Chat', v => {
            let playerName = this.players.getChildByName(v.user.uid)?.getComponent(PlayerName);
            if (playerName) {
                playerName.showChatMsg(v.content);
            }
            this._pushChatMsg(`<outline width=2><color=#00C113>${v.user.name}</color> <color=#000000>${v.content}</color></o>`);
        })
        this.client.listenMsg('serverMsg/UserStates', v => {
            for (let uid in v.userStates) {
                this._updateUserState(v.userStates[uid]);
            }
        })
        this.client.listenMsg('serverMsg/UserJoin', v => {
            this.subWorldData.users.push({
                ...v.user
            });
            this._pushChatMsg(`<outline width=2><color=#00C113>${v.user.name}</color> <color=#999999>加入了房间</color></o>`)
        })
        this.client.listenMsg('serverMsg/UserExit', v => {
            this.subWorldData.users.remove(v1 => v1.uid === v.user.uid);
            this.playerNames.getChildByName(v.user.uid)?.removeFromParent();
            this.players.getChildByName(v.user.uid)?.removeFromParent();
            this._pushChatMsg(`<outline width=2><color=#00C113>${v.user.name}</color> <color=#999999>离开了房间</color></o>`)
        })
        this.client.flows.postDisconnectFlow.push(v => {
            if (!v.isManual) {
                tgxUIAlert.show("链接已断开，请重新登录").onClick(() => {
                    this.onBtnBack();
                });
            }
            return v;
        })
    }

    private async _ensureConnected(): Promise<ResJoinSubWorld> {
        let ret = await this._connect();
        if (!ret.isSucc) {
            tgxUIAlert.show(ret.errMsg).onClick(() => {
                this.onBtnBack();
            });
            return new Promise(rs => { });
        }

        this._resetSubWorldState()
        return ret.res;
    }
    private async _connect(): Promise<{ isSucc: true, res: ResJoinSubWorld } | { isSucc: false, errMsg: string }> {
        // Connect
        let resConnect = await this.client.connect();
        if (!resConnect.isSucc) {
            return { isSucc: false, errMsg: '连接到服务器失败: ' + resConnect.errMsg };
        }

        // JoinSubWorld
        let retJoin = await this.client.callApi('JoinSubWorld', {
            token: this.params.token,
            uid: UserMgr.inst.uid,
            time: this.params.time,
            subWorldId: UserMgr.inst.subWorldId,
        });
        if (!retJoin.isSucc) {
            return { isSucc: false, errMsg: '加入房间失败: ' + retJoin.err.message };
        }

        this.currentUser = retJoin.res.currentUser;
        this.subWorldData = retJoin.res.subWorldData;
        this.labelRoomName.string = retJoin.res.subWorldData.name;

        return { isSucc: true, res: retJoin.res };
    }

    private _resetSubWorldState() {
        if (this.client.status === WsClientStatus.Opened) {
            this.labelRoomState.string = `人数: ${this.players.children.length}\nPing: ${this.client.lastHeartbeatLatency}ms`
        }
        else {
            this.labelRoomState.string = '连接中...'
        }
    }

    onBtnAction(e: any, state: 'wave' | 'punch') {
        if (!this.selfPlayer) {
            return;
        }
        this.selfPlayer.aniState = state;
    }

    async onBtnSendChat() {
        if (!this.inputChat.string) {
            return;
        }

        const content = this.inputChat.string;
        this.inputChat.string = '';
        let ret = await this.client.callApi('SendChat', {
            content: content
        });
        this.inputChat.string = '';

        if (!ret.isSucc) {
            this.inputChat.string = content;
            return;
        }
    }
    async onInputChatReturn() {
        await this.onBtnSendChat();
        this.inputChat.focus();
    }

    private _pushChatMsg(richText: string) {
        let node = instantiate(this.prefabChatMsgItem);
        this.chatMsgs.addChild(node);
        node.getComponent(RichText)!.string = richText;

        // 最多保留 7 条记录
        while (this.chatMsgs.children.length > 7) {
            this.chatMsgs.children[0].removeFromParent();
        }
    }

    onBtnBack() {
        this.client.disconnect();
        SceneUtil.loadScene(SceneDef.LOGIN);
    }

    private _updateUserState(state: SubWorldUserState) {
        let node = this.players.getChildByName(state.uid);

        // Create Player
        if (!node) {
            // Player
            node = instantiate(this.prefabPlayer);
            node.name = state.uid;
            this.players.addChild(node);
            node.setPosition(state.pos.x, state.pos.y, state.pos.z);
            node.setRotation(state.rotation.x, state.rotation.y, state.rotation.z, state.rotation.w);
            const player = node.getComponent(Player)!;
            player.aniState = state.aniState;
            let userInfo = this.subWorldData.users.find(v => v.uid === state.uid);
            if (userInfo) {
                let color = new Color();
                Color.fromUint32(color, userInfo.visualId);
                player.mesh.material?.setProperty('mainColor', color);
            }

            player.lblName.string = userInfo?.name || '???';

            // Set selfPlayer
            if (state.uid === this.currentUser.uid) {
                this.selfPlayer = player;
                this.followCamera.target = node.getChildByName('focusTarget')!;
            }

            return;
        }

        // 简单起见：自己以本地状态为主，不从服务端同步
        if (state.uid === this.currentUser.uid) {
            return;
        }

        // 插值其它 Player 的状态
        node.getComponent(Player)!.aniState = state.aniState;
        TweenSystem.instance.ActionManager.removeAllActionsFromTarget(node.position as any);
        const startRot = node!.rotation.clone();
        tween(node.position).to(0.1, state.pos, {
            onUpdate: (v, ratio) => {
                node!.position = node!.position;
                node!.rotation = Quat.slerp(node!.rotation, startRot, state.rotation, ratio!)
            }
        }).tag(99).start();
    }

    onDestroy() {
        TweenSystem.instance.ActionManager.removeAllActionsByTag(99);
    }

}