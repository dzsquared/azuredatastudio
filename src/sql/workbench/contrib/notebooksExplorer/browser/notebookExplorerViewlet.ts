/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the Source EULA. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from 'vs/nls';
import { IWorkbenchContribution } from 'vs/workbench/common/contributions';
import { IAction } from 'vs/base/common/actions';
import { append, $, addClass, toggleClass, Dimension, IFocusTracker } from 'vs/base/browser/dom';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { IExtensionService } from 'vs/workbench/services/extensions/common/extensions';
import { IThemeService } from 'vs/platform/theme/common/themeService';
import { IViewletViewOptions } from 'vs/workbench/browser/parts/views/viewsViewlet';
import { IStorageService } from 'vs/platform/storage/common/storage';
import { IWorkspaceContextService } from 'vs/platform/workspace/common/workspace';
import { IContextMenuService } from 'vs/platform/contextview/browser/contextView';
import { Extensions as ViewContainerExtensions, IViewDescriptor, IViewsRegistry, IViewContainersRegistry, ViewContainerLocation, IViewDescriptorService } from 'vs/workbench/common/views';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { IWorkbenchLayoutService } from 'vs/workbench/services/layout/browser/layoutService';
import { Registry } from 'vs/platform/registry/common/platform';
import { IMenuService, MenuId } from 'vs/platform/actions/common/actions';
import { IContextKeyService, IContextKey } from 'vs/platform/contextkey/common/contextkey';
import { ShowViewletAction, Viewlet } from 'vs/workbench/browser/viewlet';
import { IEditorGroupsService } from 'vs/workbench/services/editor/common/editorGroupsService';
import { IViewletService } from 'vs/workbench/services/viewlet/browser/viewlet';
import { ViewPaneContainer, ViewPane } from 'vs/workbench/browser/parts/views/viewPaneContainer';
import { SyncDescriptor } from 'vs/platform/instantiation/common/descriptors';
import { NotebookSearchWidget, INotebookExplorerSearchOptions } from 'sql/workbench/contrib/notebooksExplorer/browser/notebookSearchWidget';
import * as Constants from 'sql/workbench/contrib/notebooksExplorer/common/constants';
import { IChangeEvent } from 'vs/workbench/contrib/search/common/searchModel';
import { Delayer } from 'vs/base/common/async';
import { ITextQuery, IPatternInfo } from 'vs/workbench/services/search/common/search';
import { MessageType } from 'vs/base/browser/ui/inputbox/inputBox';
import { QueryBuilder, ITextQueryBuilderOptions } from 'vs/workbench/contrib/search/common/queryBuilder';
import { IFileService } from 'vs/platform/files/common/files';
import { getOutOfWorkspaceEditorResources } from 'vs/workbench/contrib/search/common/search';
import { TreeViewPane, TreeView } from 'sql/workbench/browser/parts/views/treeView';
import { NotebookSearchView } from 'sql/workbench/contrib/notebooksExplorer/browser/notebookSearchView';

export const VIEWLET_ID = 'workbench.view.notebooks';

// Viewlet Action
export class OpenNotebookExplorerViewletAction extends ShowViewletAction {
	public static ID = VIEWLET_ID;
	public static LABEL = localize('showNotebookExplorer', "Show Notebooks");

	constructor(
		id: string,
		label: string,
		@IViewletService viewletService: IViewletService,
		@IEditorGroupsService editorGroupService: IEditorGroupsService,
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService
	) {
		super(id, label, VIEWLET_ID, viewletService, editorGroupService, layoutService);
	}
}

export class NotebookExplorerViewletViewsContribution implements IWorkbenchContribution {

	constructor() {
		this.registerViews();
	}

	private registerViews(): void {
		let viewDescriptors = [];
		viewDescriptors.push(this.createNotebookSearchViewDescriptor());
		Registry.as<IViewsRegistry>(ViewContainerExtensions.ViewsRegistry).registerViews(viewDescriptors, NOTEBOOK_VIEW_CONTAINER);
	}

	createNotebookSearchViewDescriptor(): IViewDescriptor {
		return {
			id: NotebookSearchView.ID,
			name: localize('notebookExplorer.searchResults', "Search Results"),
			ctorDescriptor: new SyncDescriptor(NotebookSearchView),
			weight: 100,
			canToggleVisibility: true,
			hideByDefault: true,
			order: 0,
		};
	}
}

export class NotebookExplorerViewlet extends Viewlet {
	constructor(
		@ITelemetryService telemetryService: ITelemetryService,
		@IStorageService protected storageService: IStorageService,
		@IInstantiationService protected instantiationService: IInstantiationService,
		@IThemeService themeService: IThemeService,
		@IContextMenuService protected contextMenuService: IContextMenuService,
		@IExtensionService protected extensionService: IExtensionService,
		@IWorkspaceContextService protected contextService: IWorkspaceContextService,
		@IWorkbenchLayoutService protected layoutService: IWorkbenchLayoutService,
		@IConfigurationService protected configurationService: IConfigurationService
	) {
		super(VIEWLET_ID, instantiationService.createInstance(NotebookExplorerViewPaneContainer), telemetryService, storageService, instantiationService, themeService, contextMenuService, extensionService, contextService, layoutService, configurationService);
	}
}

export class NotebookExplorerViewPaneContainer extends ViewPaneContainer {
	private root: HTMLElement;
	private static readonly MAX_TEXT_RESULTS = 10000;
	private notebookSourcesBox: HTMLElement;
	searchWidget!: NotebookSearchWidget;
	private inputBoxFocused: IContextKey<boolean>;
	private triggerQueryDelayer: Delayer<void>;
	private pauseSearching = false;
	private queryBuilder: QueryBuilder;
	private searchView: NotebookSearchView;

	constructor(
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@ITelemetryService telemetryService: ITelemetryService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IWorkspaceContextService contextService: IWorkspaceContextService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IExtensionService extensionService: IExtensionService,
		@IConfigurationService configurationService: IConfigurationService,
		@IMenuService private menuService: IMenuService,
		@IContextKeyService private contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IFileService private readonly fileService: IFileService,
	) {
		super(VIEWLET_ID, { mergeViewWithContainerWhenSingleView: true }, instantiationService, configurationService, layoutService, contextMenuService, telemetryService, extensionService, themeService, storageService, contextService, viewDescriptorService);
		this.inputBoxFocused = Constants.InputBoxFocusedKey.bindTo(this.contextKeyService);
		this.triggerQueryDelayer = this._register(new Delayer<void>(0));
		this.queryBuilder = this.instantiationService.createInstance(QueryBuilder);
	}

	create(parent: HTMLElement): void {
		addClass(parent, 'notebookExplorer-viewlet');
		this.root = parent;

		const header = append(this.root, $('.header'));
		this.createSearchWidget(header);

		this.notebookSourcesBox = append(this.root, $('.notebookSources'));

		return super.create(this.notebookSourcesBox);
	}

	private createSearchWidget(container: HTMLElement): void {
		this.searchWidget = this._register(this.instantiationService.createInstance(NotebookSearchWidget, container, <INotebookExplorerSearchOptions>{
			value: '',
			replaceValue: undefined,
			isRegex: false,
			isCaseSensitive: false,
			isWholeWords: false,
			searchHistory: [],
			replaceHistory: [],
			preserveCase: false
		}));


		this._register(this.searchWidget.onSearchSubmit(options => this.triggerQueryChange(options)));
		this._register(this.searchWidget.onSearchCancel(({ focus }) => this.cancelSearch(focus)));
		this._register(this.searchWidget.searchInput.onDidOptionChange(() => this.triggerQueryChange()));

		// this._register(this.searchWidget.onDidHeightChange(() => this.reLayout()));

		this._register(this.searchWidget.onPreserveCaseChange((state) => {
			// this.viewModel.preserveCase = state;
			this.refreshTree();
		}));

		this._register(this.searchWidget.onBlur(() => {
			// this.toggleQueryDetailsButton.focus();
		}));

		this.trackInputBox(this.searchWidget.searchInputFocusTracker);
		let containerModel = this.viewDescriptorService.getViewContainerModel(this.viewContainer);
		let viewDescriptors = containerModel.visibleViewDescriptors;
		if (viewDescriptors.length === 1) {
			this.toggleViewVisibility(NotebookSearchView.ID);
		}
	}

	cancelSearch(focus: boolean = true): boolean {
		if (focus) {
			this.searchWidget.focus();
			return true;
		}
		return false;
	}

	triggerQueryChange(_options?: { preserveFocus?: boolean, triggeredOnType?: boolean, delay?: number }) {
		const options = { preserveFocus: true, triggeredOnType: false, delay: 0, ..._options };

		if (!this.pauseSearching) {
			this.triggerQueryDelayer.trigger(() => {
				this._onQueryChanged(options.preserveFocus, options.triggeredOnType);
			}, options.delay);
		}
	}

	private _onQueryChanged(preserveFocus: boolean, triggeredOnType = false): void {
		if (!this.searchWidget.searchInput.inputBox.isInputValid()) {
			return;
		}

		const isRegex = this.searchWidget.searchInput.getRegex();
		const isWholeWords = this.searchWidget.searchInput.getWholeWords();
		const isCaseSensitive = this.searchWidget.searchInput.getCaseSensitive();
		const contentPattern = this.searchWidget.searchInput.getValue();

		if (contentPattern.length === 0) {
			this.clearSearchResults(false);
			this.updateViewletsVisibility();
			return;
		}

		const content: IPatternInfo = {
			pattern: contentPattern,
			isRegExp: isRegex,
			isCaseSensitive: isCaseSensitive,
			isWordMatch: isWholeWords
		};

		const excludePattern = undefined;
		const includePattern = undefined;

		// Need the full match line to correctly calculate replace text, if this is a search/replace with regex group references ($1, $2, ...).
		// 10000 chars is enough to avoid sending huge amounts of text around, if you do a replace with a longer match, it may or may not resolve the group refs correctly.
		// https://github.com/Microsoft/vscode/issues/58374
		const charsPerLine = content.isRegExp ? 10000 : 1000;

		const options: ITextQueryBuilderOptions = {
			_reason: 'searchView',
			extraFileResources: this.instantiationService.invokeFunction(getOutOfWorkspaceEditorResources),
			maxResults: NotebookExplorerViewPaneContainer.MAX_TEXT_RESULTS,
			disregardIgnoreFiles: undefined,
			disregardExcludeSettings: undefined,
			excludePattern,
			includePattern,
			previewOptions: {
				matchLines: 1,
				charsPerLine
			},
			isSmartCase: this.searchConfig.smartCase,
			expandPatterns: true
		};
		const folderResources = this.contextService.getWorkspace().folders;

		const onQueryValidationError = (err: Error) => {
			this.searchWidget.searchInput.showMessage({ content: err.message, type: MessageType.ERROR });
			// this.viewModel.searchResult.clear();
		};

		let query: ITextQuery;
		try {
			query = this.queryBuilder.text(content, folderResources.map(folder => folder.uri), options);
		} catch (err) {
			onQueryValidationError(err);
			return;
		}

		this.validateQuery(query).then(() => {
			// this.onQueryTriggered(query, options, excludePatternText, includePatternText, triggeredOnType);
			if (this.views.length > 1) {
				let booksViewPane = (<TreeViewPane>this.views[0]).getTreeView();
				if (booksViewPane instanceof TreeView) {
					let dataProvider = booksViewPane?.dataProvider;
					if (dataProvider) {
						let items = dataProvider.getChildren();
						items.then(results => {
							results.forEach(root => {
								booksViewPane.collapse(root);
								root.children?.forEach(bookItem => {
									booksViewPane.collapse(bookItem);
									if (bookItem.label.label.indexOf(query.contentPattern.pattern) > 0) {
										booksViewPane.expand(bookItem);
									}
								});
							});
						});
					}
				}
			}

			if (!preserveFocus) {
				this.searchWidget.focus(false, true); // focus back to input field
			}
			this.updateViewletsVisibility();
		}, onQueryValidationError);
	}

	updateViewletsVisibility(): void {
		let containerModel = this.viewDescriptorService.getViewContainerModel(this.viewContainer);
		let visibleViewDescriptors = containerModel.visibleViewDescriptors;
		if (this.searchWidget.searchInput.getValue().length > 0) {
			if (visibleViewDescriptors.length > 1) {
				let allViews = containerModel.allViewDescriptors;
				allViews.forEach(view => {
					this.toggleViewVisibility(view.id);
				});
				this.getView(NotebookSearchView.ID)?.setVisible(true);
			}
		} else {
			if (visibleViewDescriptors.length === 1) {
				let allViews = containerModel.allViewDescriptors;
				allViews.forEach(view => {
					this.toggleViewVisibility(view.id);
				});
				this.getView(NotebookSearchView.ID)?.setVisible(false);
			}
		}
	}

	showSearchResultsView(): void {
		this.searchView = <NotebookSearchView>this.getView(NotebookSearchView.ID);
		if (!this.searchView) {
			this.toggleViewVisibility(NotebookSearchView.ID);
		} else {
			this.searchView.setVisible(true);
		}
	}

	clearSearchResults(clearInput = true): void {
		// this.viewModel.searchResult.clear();
		/* this.showEmptyStage(true);
		if (this.contextService.getWorkbenchState() === WorkbenchState.EMPTY) {
			this.showSearchWithoutFolderMessage();
		} */
		if (clearInput) {
			this.searchWidget.clear();
		}
		// this.viewModel.cancelSearch();
		// this.updateActions();
	}

	private validateQuery(query: ITextQuery): Promise<void> {
		// Validate folderQueries
		const folderQueriesExistP =
			query.folderQueries.map(fq => {
				return this.fileService.exists(fq.folder);
			});

		return Promise.all(folderQueriesExistP).then(existResults => {
			// If no folders exist, show an error message about the first one
			const existingFolderQueries = query.folderQueries.filter((folderQuery, i) => existResults[i]);
			if (!query.folderQueries.length || existingFolderQueries.length) {
				query.folderQueries = existingFolderQueries;
			} else {
				const nonExistantPath = query.folderQueries[0].folder.fsPath;
				const searchPathNotFoundError = localize('searchPathNotFoundError', "Search path not found: {0}", nonExistantPath);
				return Promise.reject(new Error(searchPathNotFoundError));
			}

			return undefined;
		});
	}



	refreshTree(event?: IChangeEvent): void {
		// const collapseResults = this.searchConfig.collapseResults;
		if (!event || event.added || event.removed) {
			// Refresh whole tree
			if (this.searchConfig.sortOrder === Constants.SearchSortOrder.Modified) {
				// Ensure all matches have retrieved their file stat
				// this.retrieveFileStats()
				// .then(() => this.tree.setChildren(null, this.createResultIterator(collapseResults)));
			} else {
				// this.tree.setChildren(null, this.createResultIterator(collapseResults));
			}
		} else {
			// If updated counts affect our search order, re-sort the view.
			if (this.searchConfig.sortOrder === Constants.SearchSortOrder.CountAscending ||
				this.searchConfig.sortOrder === Constants.SearchSortOrder.CountDescending) {
				// this.tree.setChildren(null, this.createResultIterator(collapseResults));
			} else {
				// FileMatch modified, refresh those elements
				event.elements.forEach(element => {
					// this.tree.setChildren(element, this.createIterator(element, collapseResults));
					// this.tree.rerender(element);
				});
			}
		}
	}

	private get searchConfig(): Constants.ISearchConfigurationProperties {
		return this.configurationService.getValue<Constants.ISearchConfigurationProperties>('notebookExplorerSearch');
	}

	private trackInputBox(inputFocusTracker: IFocusTracker, contextKey?: IContextKey<boolean>): void {
		this._register(inputFocusTracker.onDidFocus(() => {
			this.inputBoxFocused.set(true);
			if (contextKey) {
				contextKey.set(true);
			}
		}));
		this._register(inputFocusTracker.onDidBlur(() => {
			this.inputBoxFocused.set(this.searchWidget.searchInputHasFocus());
			if (contextKey) {
				contextKey.set(false);
			}
		}));
	}


	public updateStyles(): void {
		super.updateStyles();
	}

	focus(): void {
	}

	layout(dimension: Dimension): void {
		toggleClass(this.root, 'narrow', dimension.width <= 300);
		super.layout(new Dimension(dimension.width, dimension.height));
	}

	getOptimalWidth(): number {
		return 400;
	}

	getSecondaryActions(): IAction[] {
		let menu = this.menuService.createMenu(MenuId.NotebookExplorerAction, this.contextKeyService);
		let actions = [];
		menu.getActions({}).forEach(group => {
			if (group[0] === 'secondary') {
				actions.push(...group[1]);
			}
		});
		menu.dispose();
		return actions;
	}

	protected createView(viewDescriptor: IViewDescriptor, options: IViewletViewOptions): ViewPane {
		let viewletPanel = this.instantiationService.createInstance(viewDescriptor.ctorDescriptor.ctor, options) as ViewPane;
		this._register(viewletPanel);
		return viewletPanel;
	}
}

export const NOTEBOOK_VIEW_CONTAINER = Registry.as<IViewContainersRegistry>(ViewContainerExtensions.ViewContainersRegistry).registerViewContainer({
	id: VIEWLET_ID,
	name: localize('notebookExplorer.name', "Notebooks"),
	ctorDescriptor: new SyncDescriptor(NotebookExplorerViewPaneContainer),
	icon: 'notebookExplorer',
	order: 6,
	storageId: `${VIEWLET_ID}.state`
}, ViewContainerLocation.Sidebar);