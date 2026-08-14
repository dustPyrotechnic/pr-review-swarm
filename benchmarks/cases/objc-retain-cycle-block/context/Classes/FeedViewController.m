#import "FeedViewController.h"
#import "FeedService.h"

@interface FeedViewController ()
// service 由本控制器持有，且它会一直保留 completion block 直到请求结束。
@property (nonatomic, strong) FeedService *service;
@property (nonatomic, strong) NSArray *items;
@property (nonatomic, strong) UITableView *tableView;
@end

@implementation FeedViewController

- (instancetype)init {
  self = [super init];
  if (self) {
    _service = [[FeedService alloc] init];
  }
  return self;
}

- (void)setupTableView {
  self.tableView = [[UITableView alloc] initWithFrame:self.view.bounds];
  [self.view addSubview:self.tableView];
}

- (void)reload {
  [self startRefreshing];
}
- (void)viewDidLoad {
  [super viewDidLoad];
}

- (void)startRefreshing {
  [self.service fetchFeedWithCompletion:^(NSArray *items) {
    self.items = items;
    [self.tableView reloadData];
  }];
}

- (void)dealloc {
  [[NSNotificationCenter defaultCenter] removeObserver:self];
}


@end
