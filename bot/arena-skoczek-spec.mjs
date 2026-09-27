// Frozen research 3.14 state_graph-59, unchanged JSON (including source clock).
// Paper scheduling uses 30-minute closed decisions; signal venue is explicitly HL.
export default {
  "schema": 3,
  "id": "state_graph-59",
  "kind": "state_graph",
  "backend": "signed-v1",
  "every_h": 0.25,
  "params": {
    "asset": 2,
    "side": 1,
    "gross_cap": 1,
    "position_atr": "atr14",
    "initial": "watch",
    "exit": "exit",
    "states": {
      "watch": {
        "action": {
          "kind": "flat"
        },
        "next": [
          {
            "to": "enter",
            "label": "entry-atoms",
            "when": {
              "all": [
                {
                  "left": {
                    "feature": "vol14",
                    "asset": 2
                  },
                  "op": "ge",
                  "right": 0.03
                },
                {
                  "left": {
                    "feature": "er48",
                    "asset": 2
                  },
                  "op": "gt",
                  "right": 0
                }
              ]
            }
          }
        ]
      },
      "enter": {
        "action": {
          "kind": "allocate",
          "weight": 0.3
        },
        "next": [
          {
            "to": "exit",
            "label": "underwater",
            "when": {
              "all": [
                {
                  "left": {
                    "metric": "age_h"
                  },
                  "op": "gt",
                  "right": 24
                },
                {
                  "left": {
                    "metric": "move_atr"
                  },
                  "op": "lt",
                  "right": 0
                }
              ]
            }
          },
          {
            "to": "exit",
            "label": "stop",
            "when": {
              "left": {
                "metric": "move_atr"
              },
              "op": "le",
              "right": -1.6
            }
          },
          {
            "to": "exit",
            "label": "take-profit",
            "when": {
              "left": {
                "metric": "move_atr"
              },
              "op": "ge",
              "right": 3.2
            }
          },
          {
            "to": "exit",
            "label": "trailing",
            "when": {
              "all": [
                {
                  "left": {
                    "metric": "peak_move_atr"
                  },
                  "op": "ge",
                  "right": 0.5
                },
                {
                  "left": {
                    "metric": "giveback_atr"
                  },
                  "op": "ge",
                  "right": 1
                }
              ]
            }
          },
          {
            "to": "manage0",
            "label": "actual-fill",
            "when": {
              "left": {
                "metric": "ready"
              },
              "op": "eq",
              "right": 1
            }
          }
        ]
      },
      "manage0": {
        "action": {
          "kind": "hold"
        },
        "next": [
          {
            "to": "exit",
            "label": "underwater",
            "when": {
              "all": [
                {
                  "left": {
                    "metric": "age_h"
                  },
                  "op": "gt",
                  "right": 24
                },
                {
                  "left": {
                    "metric": "move_atr"
                  },
                  "op": "lt",
                  "right": 0
                }
              ]
            }
          },
          {
            "to": "exit",
            "label": "stop",
            "when": {
              "left": {
                "metric": "move_atr"
              },
              "op": "le",
              "right": -1.6
            }
          },
          {
            "to": "exit",
            "label": "take-profit",
            "when": {
              "left": {
                "metric": "move_atr"
              },
              "op": "ge",
              "right": 3.2
            }
          },
          {
            "to": "exit",
            "label": "trailing",
            "when": {
              "all": [
                {
                  "left": {
                    "metric": "peak_move_atr"
                  },
                  "op": "ge",
                  "right": 0.5
                },
                {
                  "left": {
                    "metric": "giveback_atr"
                  },
                  "op": "ge",
                  "right": 1
                }
              ]
            }
          },
          {
            "to": "stage0",
            "label": "stage-trigger",
            "when": {
              "all": [
                {
                  "left": {
                    "metric": "filled"
                  },
                  "op": "eq",
                  "right": 1
                },
                {
                  "left": {
                    "metric": "move_atr"
                  },
                  "op": "ge",
                  "right": 0.5
                }
              ]
            }
          }
        ]
      },
      "stage0": {
        "action": {
          "kind": "allocate",
          "weight": 1
        },
        "next": [
          {
            "to": "exit",
            "label": "underwater",
            "when": {
              "all": [
                {
                  "left": {
                    "metric": "age_h"
                  },
                  "op": "gt",
                  "right": 24
                },
                {
                  "left": {
                    "metric": "move_atr"
                  },
                  "op": "lt",
                  "right": 0
                }
              ]
            }
          },
          {
            "to": "exit",
            "label": "stop",
            "when": {
              "left": {
                "metric": "move_atr"
              },
              "op": "le",
              "right": -1.6
            }
          },
          {
            "to": "exit",
            "label": "take-profit",
            "when": {
              "left": {
                "metric": "move_atr"
              },
              "op": "ge",
              "right": 3.2
            }
          },
          {
            "to": "exit",
            "label": "trailing",
            "when": {
              "all": [
                {
                  "left": {
                    "metric": "peak_move_atr"
                  },
                  "op": "ge",
                  "right": 0.5
                },
                {
                  "left": {
                    "metric": "giveback_atr"
                  },
                  "op": "ge",
                  "right": 1
                }
              ]
            }
          },
          {
            "to": "manage1",
            "label": "stage-filled",
            "when": {
              "left": {
                "metric": "ready"
              },
              "op": "eq",
              "right": 1
            }
          }
        ]
      },
      "manage1": {
        "action": {
          "kind": "hold"
        },
        "next": [
          {
            "to": "exit",
            "label": "underwater",
            "when": {
              "all": [
                {
                  "left": {
                    "metric": "age_h"
                  },
                  "op": "gt",
                  "right": 24
                },
                {
                  "left": {
                    "metric": "move_atr"
                  },
                  "op": "lt",
                  "right": 0
                }
              ]
            }
          },
          {
            "to": "exit",
            "label": "stop",
            "when": {
              "left": {
                "metric": "move_atr"
              },
              "op": "le",
              "right": -1.6
            }
          },
          {
            "to": "exit",
            "label": "take-profit",
            "when": {
              "left": {
                "metric": "move_atr"
              },
              "op": "ge",
              "right": 3.2
            }
          },
          {
            "to": "exit",
            "label": "trailing",
            "when": {
              "all": [
                {
                  "left": {
                    "metric": "peak_move_atr"
                  },
                  "op": "ge",
                  "right": 0.5
                },
                {
                  "left": {
                    "metric": "giveback_atr"
                  },
                  "op": "ge",
                  "right": 1
                }
              ]
            }
          },
          {
            "to": "stage1",
            "label": "stage-trigger",
            "when": {
              "all": [
                {
                  "left": {
                    "metric": "filled"
                  },
                  "op": "eq",
                  "right": 1
                },
                {
                  "left": {
                    "metric": "move_atr"
                  },
                  "op": "ge",
                  "right": 1
                }
              ]
            }
          }
        ]
      },
      "stage1": {
        "action": {
          "kind": "trim",
          "keep": 0.25
        },
        "next": [
          {
            "to": "exit",
            "label": "underwater",
            "when": {
              "all": [
                {
                  "left": {
                    "metric": "age_h"
                  },
                  "op": "gt",
                  "right": 24
                },
                {
                  "left": {
                    "metric": "move_atr"
                  },
                  "op": "lt",
                  "right": 0
                }
              ]
            }
          },
          {
            "to": "exit",
            "label": "stop",
            "when": {
              "left": {
                "metric": "move_atr"
              },
              "op": "le",
              "right": -1.6
            }
          },
          {
            "to": "exit",
            "label": "take-profit",
            "when": {
              "left": {
                "metric": "move_atr"
              },
              "op": "ge",
              "right": 3.2
            }
          },
          {
            "to": "exit",
            "label": "trailing",
            "when": {
              "all": [
                {
                  "left": {
                    "metric": "peak_move_atr"
                  },
                  "op": "ge",
                  "right": 0.5
                },
                {
                  "left": {
                    "metric": "giveback_atr"
                  },
                  "op": "ge",
                  "right": 1
                }
              ]
            }
          },
          {
            "to": "run",
            "label": "stage-filled",
            "when": {
              "left": {
                "metric": "ready"
              },
              "op": "eq",
              "right": 1
            }
          }
        ]
      },
      "run": {
        "action": {
          "kind": "hold"
        },
        "next": [
          {
            "to": "exit",
            "label": "underwater",
            "when": {
              "all": [
                {
                  "left": {
                    "metric": "age_h"
                  },
                  "op": "gt",
                  "right": 24
                },
                {
                  "left": {
                    "metric": "move_atr"
                  },
                  "op": "lt",
                  "right": 0
                }
              ]
            }
          },
          {
            "to": "exit",
            "label": "stop",
            "when": {
              "left": {
                "metric": "move_atr"
              },
              "op": "le",
              "right": -1.6
            }
          },
          {
            "to": "exit",
            "label": "take-profit",
            "when": {
              "left": {
                "metric": "move_atr"
              },
              "op": "ge",
              "right": 3.2
            }
          },
          {
            "to": "exit",
            "label": "trailing",
            "when": {
              "all": [
                {
                  "left": {
                    "metric": "peak_move_atr"
                  },
                  "op": "ge",
                  "right": 0.5
                },
                {
                  "left": {
                    "metric": "giveback_atr"
                  },
                  "op": "ge",
                  "right": 1
                }
              ]
            }
          }
        ]
      },
      "exit": {
        "action": {
          "kind": "flat"
        },
        "next": [
          {
            "to": "watch",
            "label": "actually-flat",
            "when": {
              "left": {
                "metric": "filled"
              },
              "op": "eq",
              "right": 0
            }
          }
        ]
      }
    }
  }
};

