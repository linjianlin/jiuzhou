import { App, Button, Modal, Segmented } from 'antd';
import { useEffect, useMemo } from 'react';
import { useIsMobile } from '../../shared/responsive';
import { JOINED_PANEL_ITEMS, NO_SECT_PANEL_ITEMS } from './constants';
import MyApplicationsPanel from './components/MyApplicationsPanel';
import NoSectHallPanel from './components/NoSectHallPanel';
import JoinedOverviewHeader from './components/JoinedOverviewHeader';
import MembersPanel from './components/MembersPanel';
import BuildingsPanel from './components/BuildingsPanel';
import ShopPanel from './components/ShopPanel';
import QuestPanel from './components/QuestPanel';
import ManagePanel from './components/ManagePanel';
import LogsPanel from './components/LogsPanel';
import CreateSectDialog from './components/dialogs/CreateSectDialog';
import DonateDialog from './components/dialogs/DonateDialog';
import MemberActionDialog from './components/dialogs/MemberActionDialog';
import AnnouncementDialog from './components/dialogs/AnnouncementDialog';
import { useSectData } from './hooks/useSectData';
import type { SectModalProps, SectPanelKey } from './types';
import './index.scss';

/**
 * 宗门弹窗容器组件。
 * 输入：开关状态、玩家信息、状态变更回调。
 * 输出：完整宗门交互界面（入宗前大厅 + 入宗后管理）。
 * 关键点：
 * 1) 仅负责布局与面板编排；
 * 2) 业务状态与网络动作全部下沉到 useSectData。
 */
const SectModal: React.FC<SectModalProps> = ({ open, onClose, spiritStones = 0, playerName = '我', onChanged }) => {
  const { modal } = App.useApp();
  const isMobile = useIsMobile();

  const data = useSectData({
    open,
    spiritStones,
    playerName,
    onChanged,
  });

  const menuItems = useMemo(() => {
    return data.joinState === 'joined' ? JOINED_PANEL_ITEMS : NO_SECT_PANEL_ITEMS;
  }, [data.joinState]);

  useEffect(() => {
    if (!open) return;
    const valid = menuItems.some((item) => item.key === data.panel);
    if (valid) return;
    if (menuItems.length <= 0) return;
    data.setPanel(menuItems[0].key);
  }, [data.panel, data.setPanel, menuItems, open]);

  useEffect(() => {
    if (!open) return;
    if (data.joinState !== 'joined' && data.panel === 'myApplications') {
      void data.refreshMyApplications();
    }
  }, [data.joinState, data.panel, data.refreshMyApplications, open]);

  const renderPanel = () => {
    if (data.joinState !== 'joined') {
      if (data.panel === 'myApplications') {
        return (
          <MyApplicationsPanel
            loading={data.myApplicationsLoading}
            applications={data.myApplications}
            actionLoadingKey={data.actionLoadingKey}
            onRefresh={() => {
              void data.refreshMyApplications();
            }}
            onCancel={(applicationId) => {
              void data.cancelMyApplication(applicationId);
            }}
          />
        );
      }

      return (
        <NoSectHallPanel
          listLoading={data.listLoading}
          searchKeyword={data.searchKeyword}
          onSearchKeywordChange={data.setSearchKeyword}
          onSearch={() => {
            void data.refreshList();
          }}
          onOpenCreate={() => {
            data.setCreateOpen(true);
          }}
          sects={data.sects}
          joinState={data.joinState}
          activeSectId={data.activeSectId}
          actionLoadingKey={data.actionLoadingKey}
          onApplyJoin={data.applyJoin}
        />
      );
    }

    if (data.panel === 'overview') {
      return (
        <div className="sect-pane">
          <div className="sect-pane-top">
            <div className="sect-pane-title-wrap">
              <div className="sect-title">基础信息</div>
              <div className="sect-subtitle">查看宗门概览、资源统计、公告与最近日志。</div>
            </div>
          </div>
          <div className="sect-pane-body">
            <div className="sect-overview-main">
              <JoinedOverviewHeader
                summary={data.joinedSect}
                canEditAnnouncement={data.permissions.canEditAnnouncement}
                onDonate={() => {
                  data.setDonateSpiritStonesInput('');
                  data.setDonateOpen(true);
                }}
                onOpenAnnouncement={() => {
                  data.setAnnouncementDraft(String(data.mySectInfo?.sect.announcement ?? ''));
                  data.setAnnouncementOpen(true);
                }}
              />
              <LogsPanel
                embedded
                loading={data.logsLoading}
                logs={data.logs}
                onRefresh={() => {
                  void data.fetchLogs();
                }}
              />
            </div>
          </div>
        </div>
      );
    }

    if (data.panel === 'members') {
      return (
        <MembersPanel
          members={data.members}
          myMember={data.myMember}
          permissions={data.permissions}
          actionLoadingKey={data.actionLoadingKey}
          onOpenMemberAction={data.openMemberAction}
          onLeaveSect={() => {
            modal.confirm({
              title: '确认退出宗门？',
              content: '退出后将失去宗门贡献，重新加入需重新申请。',
              okText: '确认退出',
              cancelText: '取消',
              okButtonProps: { danger: true },
              onOk: async () => {
                await data.leaveSectAction();
              },
            });
          }}
        />
      );
    }

    if (data.panel === 'buildings') {
      return (
        <BuildingsPanel
          buildings={data.buildings}
          permissions={data.permissions}
          actionLoadingKey={data.actionLoadingKey}
          onUpgrade={(buildingType) => {
            void data.upgradeBuildingAction(buildingType);
          }}
        />
      );
    }

    if (data.panel === 'shop') {
      return (
        <ShopPanel
          loading={data.shopLoading}
          myContribution={data.myContribution}
          shopItems={data.shopItems}
          actionLoadingKey={data.actionLoadingKey}
          onBuy={(itemId) => {
            void data.buyShopItemAction(itemId);
          }}
        />
      );
    }

    if (data.panel === 'activity') {
      return (
        <QuestPanel
          loading={data.questsLoading}
          quests={data.quests}
          actionLoadingKey={data.actionLoadingKey}
          onAccept={(questId) => {
            void data.acceptQuestAction(questId);
          }}
          onSubmit={(questId) => {
            void data.submitQuestAction(questId);
          }}
          onClaim={(questId) => {
            void data.claimQuestAction(questId);
          }}
        />
      );
    }

    if (data.panel === 'manage') {
      return (
        <ManagePanel
          permissions={data.permissions}
          applications={data.applications}
          applicationsLoading={data.applicationsLoading}
          actionLoadingKey={data.actionLoadingKey}
          onRefreshApplications={() => {
            void data.fetchApplications();
          }}
          onHandleApplication={(applicationId, approve) => {
            void data.handleApplicationAction(applicationId, approve);
          }}
          onOpenDonate={() => {
            data.setDonateSpiritStonesInput('');
            data.setDonateOpen(true);
          }}
          onOpenAnnouncement={() => {
            data.setAnnouncementDraft(String(data.mySectInfo?.sect.announcement ?? ''));
            data.setAnnouncementOpen(true);
          }}
          onJumpToActivity={() => {
            data.setPanel('activity');
          }}
          onDisband={() => {
            modal.confirm({
              title: '确认解散宗门？',
              content: '该操作不可撤销，宗门成员将全部退出。',
              okText: '确认解散',
              cancelText: '取消',
              okButtonProps: { danger: true },
              onOk: async () => {
                await data.disbandSectAction();
              },
            });
          }}
        />
      );
    }

    return null;
  };

  return (
    <>
      <Modal
        open={open}
        onCancel={onClose}
        footer={null}
        title={null}
        centered
        width={1120}
        className="sect-modal"
        destroyOnHidden
        maskClosable
      >
        <div className="sect-shell">
          <div className="sect-left">
            <div className="sect-left-title">
              <div className="sect-left-name">宗门</div>
            </div>
            {isMobile ? (
              <div className="sect-left-segmented-wrap">
                <Segmented
                  className="sect-left-segmented"
                  value={data.panel}
                  options={menuItems.map((item) => ({ value: item.key, label: item.label }))}
                  onChange={(value) => {
                    if (typeof value !== 'string') return;
                    data.setPanel(value as SectPanelKey);
                  }}
                />
              </div>
            ) : (
              <div className="sect-left-list">
                {menuItems.map((item) => (
                  <Button
                    key={item.key}
                    type={item.key === data.panel ? 'primary' : 'default'}
                    className="sect-left-item"
                    onClick={() => {
                      data.setPanel(item.key);
                    }}
                  >
                    {item.label}
                  </Button>
                ))}
              </div>
            )}
          </div>

          <div className="sect-right">
            <div className="sect-right-body">{renderPanel()}</div>
          </div>
        </div>
      </Modal>

      <CreateSectDialog
        open={data.createOpen}
        createName={data.createName}
        createNotice={data.createNotice}
        spiritStones={spiritStones}
        createCost={data.createCost}
        canAffordCreate={data.canAffordCreate}
        actionLoadingKey={data.actionLoadingKey}
        onClose={() => data.setCreateOpen(false)}
        onNameChange={data.setCreateName}
        onNoticeChange={data.setCreateNotice}
        onConfirm={() => {
          void data.createSectAction();
        }}
      />

      <DonateDialog
        open={data.donateOpen}
        spiritStones={spiritStones}
        donateSpiritStonesInput={data.donateSpiritStonesInput}
        donateSummary={data.donateSummary}
        actionLoadingKey={data.actionLoadingKey}
        onClose={() => data.setDonateOpen(false)}
        onInputChange={data.setDonateSpiritStonesInput}
        onConfirm={() => {
          void data.donateAction();
        }}
      />

      <AnnouncementDialog
        open={data.announcementOpen}
        value={data.announcementDraft}
        actionLoadingKey={data.actionLoadingKey}
        onClose={() => data.setAnnouncementOpen(false)}
        onChange={data.setAnnouncementDraft}
        onConfirm={() => {
          void data.updateAnnouncementAction();
        }}
      />

      <MemberActionDialog
        open={data.memberActionOpen}
        draft={data.memberActionDraft}
        myMember={data.myMember}
        permissions={data.permissions}
        actionLoadingKey={data.actionLoadingKey}
        onClose={() => data.setMemberActionOpen(false)}
        onDraftChange={data.setMemberActionDraft}
        onAppoint={(targetId, position) => {
          void data.appointPositionAction(targetId, position);
        }}
        onKick={(targetId) => {
          void data.kickMemberAction(targetId);
        }}
        onTransferLeader={(targetId) => {
          void data.transferLeaderAction(targetId);
        }}
      />
    </>
  );
};

export default SectModal;
